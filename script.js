/* ============================================================
 * 商品到期提醒系统
 * 云端存储：腾讯云开发 CloudBase（替代已停服的 LeanCloud）
 *
 * 使用前必须完成的配置（详见 README.md）：
 *   1. 注册腾讯云开发 https://tcb.cloud.tencent.com/ 并创建环境
 *   2. 把下面的 ENV_ID 替换成你自己的「环境 ID」
 *   3. 控制台开启「匿名登录」，并把 Product / Mapping 两个集合的
 *      权限设置为「所有用户可读写」（否则换设备看不到数据）
 * ============================================================ */

/* ===================== 0. 云端配置 ===================== */
const ENV_ID = 'trae-projects-4g5aob6ufac38569';   // CloudBase 环境 ID
const ACCESS_KEY = '';                 // 一般留空；若报鉴权失败，再填 Publishable Key
const PRODUCT_COLLECTION = 'Product';  // 商品集合名（需与云端一致）
const MAPPING_COLLECTION = 'Mapping';  // 条码映射集合名（需与云端一致）
const PAGE_SIZE = 1000;                // 单次查询上限（CloudBase 最大 1000 条）

/* ---- GitHub 存储配置（供 GitHub Pages 版本使用）---- */
const GH_OWNER = 'halcyon0207';        // GitHub 用户名
const GH_REPO  = 'product-expiry';     // 存放数据的仓库名
const GH_FILE  = 'data.json';          // 数据文件名
const GH_API   = 'https://api.github.com';

// 数据存哪儿：GitHub 仓库（默认）还是 CloudBase 数据库（本地文件调试时用）。
//
// 同一个页面会被部署到两处（GitHub Pages、腾讯云 CloudBase 静态托管），
// 而两处的数据是分开的：一个在 product-expiry 仓库的 data.json，一个在云数据库。
// 为了不让同一个网址偶尔看到「另一套旧数据」，模式选择按下面顺序确定：
//   1. 网址参数 ?storage=github 或 ?storage=cloudbase —— 最高优先级，并会被记到本机
//   2. 本机记住的上一次选择（localStorage）—— 所以带参数访问过一次就够了
//   3. 域名默认值：github.io 以及当前腾讯云域名走 GitHub，其余走 CloudBase
//      （本地用 file:// 打开时默认走 CloudBase，方便在没 GitHub 令牌时调试）
const STORAGE_MODE_KEY = 'storageMode';
let storageModeFromUrl = false;   // 本次是不是靠网址参数切的（用来提示一次）
const DEFAULT_GITHUB_HOSTS = [
    /\.github\.io$/i,
    // 当前这个腾讯云静态托管域名，默认就用 GitHub 数据，不必每次手动带 ?storage=github
    /trae-projects-4g5aob6ufac38569.*\.tcloudbaseapp\.com$/i
];
const IS_GITHUB_PAGES = (function() {
    const fromUrl = /[?&]storage=(github|cloudbase)/i.exec(location.search);

    if (fromUrl) {
        const mode = fromUrl[1].toLowerCase();
        try { localStorage.setItem(STORAGE_MODE_KEY, mode); } catch (e) {}
        storageModeFromUrl = true;
        return mode === 'github';
    }

    let saved = '';
    try { saved = localStorage.getItem(STORAGE_MODE_KEY) || ''; } catch (e) {}
    if (saved) return saved === 'github';

    return DEFAULT_GITHUB_HOSTS.some(function(re) { return re.test(location.hostname); });
})();

let cbApp = null;         // CloudBase 应用实例
let cbDb = null;          // 数据库实例
let cloudReady = false;   // 云端是否已就绪
let cloudWatchers = [];   // 实时监听句柄

let ghToken = localStorage.getItem('ghToken') || '';   // GitHub 访问令牌（只存在本机）
let ghSha = null;         // 数据文件当前版本号（写入时必需）

/* ===================== 1. 本地数据 ===================== */
let products = JSON.parse(localStorage.getItem('products')) || [];
let productMappings = JSON.parse(localStorage.getItem('productMappings')) || [];

// 已删除记录的「墓碑」（带 deletedAt 的删除标记）。
//
// 删除不能只是把记录抹掉：别的设备手里还留着那份旧副本，
// 下次同步时它会像没事一样把记录带回来 —— 这就是「A 机删了，B 机一同步又回来」。
// 所以删除时留一条墓碑，同步时墓碑和记录一起比时间，谁新谁赢：
//   · 墓碑更新 → 记录被删掉，别的设备手里的旧副本也一并消失
//   · 记录更新 → 这条在别处被改过，以改动为准，墓碑作废（删完还能救回来）
//
// 墓碑单独放一个数组，列表、图表、导出都只看 products，不用为删除改一遍。
let productTombstones = JSON.parse(localStorage.getItem('productTombstones')) || [];
let mappingTombstones = JSON.parse(localStorage.getItem('mappingTombstones')) || [];

// 全局变量：当前显示模式（all 或 filter）
let currentDisplayMode = 'all';

// 全局搜索变量
let productSearchQuery = '';
let mappingSearchQuery = '';

// 摄像头扫码实例
let html5QrCode = null;

/* ===================== 2. 通用提示 ===================== */
function showToast(message, background, duration) {
    background = background || '#2196F3';
    duration = duration || 3000;

    // 新提示出现时先清理旧的，避免“正在获取”这类长提示一直挂着
    document.querySelectorAll('.toast-notification').forEach(function(el) {
        if (el.parentNode) el.parentNode.removeChild(el);
    });

    const notification = document.createElement('div');
    notification.className = 'toast-notification';
    notification.style.position = 'fixed';
    notification.style.top = '20px';
    notification.style.left = '50%';
    notification.style.transform = 'translateX(-50%)';
    notification.style.backgroundColor = background;
    notification.style.color = 'white';
    notification.style.padding = '12px 20px';
    notification.style.borderRadius = '8px';
    notification.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
    notification.style.zIndex = '2000';
    notification.style.fontSize = '14px';
    notification.style.maxWidth = '80%';
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(function() {
        if (document.body.contains(notification)) {
            document.body.removeChild(notification);
        }
    }, duration);
}

/* ===================== 2.1 日期工具 ===================== */

// 把 'YYYY-MM-DD' 解析成“本地时区”的当天 0 点。
// 直接 new Date('2026-09-12') 是按 UTC 解析的，在国内会差一天。
function parseDateLocal(value) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(value || '').trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
}

// 输出 'YYYY-MM-DD'（本地时区）。不能用 toISOString，同样会偏一天。
function formatDateLocal(date) {
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return date.getFullYear() + '-' + m + '-' + d;
}

function todayLocal() {
    return formatDateLocal(new Date());
}

// 加 N 个月。1月31日 + 1个月会滚到 3 月，这里收敛到当月最后一天
function addMonthsClamped(date, months) {
    const day = date.getDate();
    const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(day, lastDay));
    return target;
}

/* ===================== 2.2 摄像头扫码 ===================== */

let scannerTorchOn = false;

// 只解零售商品常见的条码格式。ZXing 每帧少试一堆格式，速度提升很明显
function retailBarcodeFormats() {
    const F = typeof Html5QrcodeSupportedFormats !== 'undefined' ? Html5QrcodeSupportedFormats : null;
    if (!F) return null;
    return [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E,
            F.CODE_128, F.CODE_39, F.ITF, F.CODABAR,
            F.QR_CODE].filter(function(v) { return v !== undefined; });
}

// 优先选择后置摄像头
function pickBackCameraId(cameras) {
    const back = cameras.find(function(c) {
        return /back|rear|environment|后置|背面/i.test(c.label || '');
    });
    return back ? back.id : cameras[cameras.length - 1].id;
}

function getVideoTrack() {
    const video = document.querySelector('#reader video');
    if (!video || !video.srcObject) return null;
    const tracks = video.srcObject.getVideoTracks ? video.srcObject.getVideoTracks() : [];
    return tracks && tracks.length ? tracks[0] : null;
}

// 只有带补光灯的设备才显示“开灯”按钮
function setupTorch() {
    const torchBtn = document.getElementById('torchBtn');
    if (!torchBtn) return;

    const track = getVideoTrack();
    if (!track || typeof track.getCapabilities !== 'function') return;

    let caps = {};
    try { caps = track.getCapabilities() || {}; } catch (e) { return; }
    if (caps.torch) torchBtn.style.display = 'inline-block';
}

// 超市、仓库光线暗的时候开补光灯，识别率提升很大
async function toggleTorch() {
    const torchBtn = document.getElementById('torchBtn');
    const track = getVideoTrack();
    if (!track) return;

    scannerTorchOn = !scannerTorchOn;
    try {
        await track.applyConstraints({ advanced: [{ torch: scannerTorchOn }] });
        if (torchBtn) {
            torchBtn.textContent = scannerTorchOn ? '关灯' : '开灯';
            torchBtn.classList.toggle('btn-info', !scannerTorchOn);
            torchBtn.classList.toggle('btn-warning', scannerTorchOn);
        }
    } catch (e) {
        scannerTorchOn = false;
        showToast('这台设备不支持补光灯', '#ff9800');
    }
}

/* ---- 对焦控制 ----
 * 手机默认的对焦策略在镜头贴近条码时会反复拉风箱（跑焦），图像一直糊着，
 * 再好的识别算法也读不出来。这里显式指定对焦模式，并开放手动重新对焦。 */
let focusRestoreTimer = null;

// 按指定模式设置对焦。设备不支持该模式时返回 false，交给调用方决定后续动作
function applyFocusConstraints(mode) {
    const track = getVideoTrack();
    if (!track || typeof track.applyConstraints !== 'function') return Promise.resolve(false);

    let caps = {};
    try { caps = track.getCapabilities ? (track.getCapabilities() || {}) : {}; } catch (e) { return Promise.resolve(false); }

    const modes = caps.focusMode || [];
    if (modes.indexOf(mode) === -1) return Promise.resolve(false);

    // 用 advanced 提交，满足不了的会被忽略而不会整体报错；
    // 顺便带上补光灯状态，免得改对焦时把灯关掉
    const advanced = [{ focusMode: mode }];
    if (caps.torch) advanced.push({ torch: scannerTorchOn });

    return track.applyConstraints({ advanced: advanced })
        .then(function() { return true; })
        .catch(function() { return false; });
}

// 手动重新对焦：先单次对焦让镜头立刻锁上，再交回连续对焦。
// 一直锁着单次对焦会锁死在错误的焦距上，反而更糟
function refocusCamera(silent) {
    const track = getVideoTrack();
    if (!track || typeof track.getCapabilities !== 'function') return;

    let caps = {};
    try { caps = track.getCapabilities() || {}; } catch (e) { return; }
    const modes = caps.focusMode || [];
    if (modes.indexOf('single-shot') === -1 && modes.indexOf('continuous') === -1) return;

    if (focusRestoreTimer) { clearTimeout(focusRestoreTimer); focusRestoreTimer = null; }

    const useSingle = modes.indexOf('single-shot') !== -1;
    applyFocusConstraints(useSingle ? 'single-shot' : 'continuous').then(function(ok) {
        if (!ok) return;
        if (!silent) showToast('正在重新对焦…', '#2196F3', 1200);
        if (!useSingle) return;
        focusRestoreTimer = setTimeout(function() {
            focusRestoreTimer = null;
            applyFocusConstraints('continuous');
        }, 1500);
    });
}

// 摄像头启动后调用。设备不暴露对焦控制时（例如 iOS Safari）直接跳过，
// 这种情况只能靠保持合适的拍摄距离来避免跑焦
function setupFocus() {
    const track = getVideoTrack();
    if (!track || typeof track.getCapabilities !== 'function') return;

    let caps = {};
    try { caps = track.getCapabilities() || {}; } catch (e) { return; }
    const modes = caps.focusMode || [];
    if (!modes.length) return;

    const refocusBtn = document.getElementById('refocusBtn');
    if (refocusBtn) {
        refocusBtn.style.display = 'inline-block';
        if (refocusBtn.dataset.bound !== '1') {
            refocusBtn.dataset.bound = '1';
            refocusBtn.addEventListener('click', function() { refocusCamera(false); });
        }
    }

    // 点画面就能重新对焦，比让用户去找按钮自然
    const reader = document.getElementById('reader');
    if (reader && reader.dataset.focusBound !== '1') {
        reader.dataset.focusBound = '1';
        reader.addEventListener('click', function() { refocusCamera(false); });
    }

    // 部分机型默认是单次对焦，会锁死在错的焦距上，这里显式要求连续对焦
    applyFocusConstraints('continuous');
}

function startScanner() {
    const modal = document.getElementById('scannerModal');
    if (!modal) return;

    modal.style.display = 'flex';

    const reader = document.getElementById('reader');
    if (reader) reader.innerHTML = '';

    const torchBtn = document.getElementById('torchBtn');
    if (torchBtn) {
        torchBtn.style.display = 'none';
        torchBtn.textContent = '开灯';
    }
    // 支持对焦控制的设备会在 setupFocus() 里重新显示
    const refocusBtn = document.getElementById('refocusBtn');
    if (refocusBtn) refocusBtn.style.display = 'none';
    if (focusRestoreTimer) { clearTimeout(focusRestoreTimer); focusRestoreTimer = null; }
    scannerTorchOn = false;

    if (typeof Html5Qrcode === 'undefined') {
        showToast('扫码库未加载，请检查网络', '#ff9800');
        stopScanner();
        return;
    }

    const hasNativeDetector = typeof window.BarcodeDetector !== 'undefined';

    const ctorOptions = {
        verbose: false,
        experimentalFeatures: { useBarCodeDetectorIfSupported: true }
    };
    // 原生 BarcodeDetector 支持哪些格式由浏览器决定，不要限制；
    // 华为自带浏览器等不支持原生检测的会退回 ZXing，这时限定格式能明显提速
    if (!hasNativeDetector) {
        const formats = retailBarcodeFormats();
        if (formats && formats.length) ctorOptions.formatsToSupport = formats;
    }

    html5QrCode = new Html5Qrcode('reader', ctorOptions);

    Html5Qrcode.getCameras().then(function(cameras) {
        if (!cameras || !cameras.length) {
            showToast('未检测到摄像头', '#ff9800');
            stopScanner();
            return;
        }

        const cameraId = pickBackCameraId(cameras);

        html5QrCode.start(
            cameraId,
            {
                // 用 15fps 而不是更高的 25fps：暗处下高帧率逼着相机用短曝光、拉高 ISO，
                // 噪点变多反而更难合焦。15 次/秒对条码识别完全够用
                fps: 15,
                disableFlip: true,
                aspectRatio: 1.7777778,
                // 一维条形码是横向长条，这里用“宽扁”识别区，方框会切掉条码
                qrbox: function(w, h) {
                    return {
                        width: Math.floor(w * 0.92),
                        height: Math.floor(h * 0.5)
                    };
                },
                // 库默认不指定分辨率，手机可能给出很低的画质导致条码糊成一团。
                // 解码画布只有预览那么大，源头给 1280x720 是清晰度和速度的平衡点
                videoConstraints: {
                    deviceId: { exact: cameraId },
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                }
            },
            function(decodedText) {
                try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) {}
                const barcodeInput = document.getElementById('barcode');
                barcodeInput.value = decodedText;
                handleBarcodeChange();
                showToast('识别成功：' + decodedText, '#4CAF50', 2000);
                stopScanner();
            },
            function() {
                // 帧解析中的临时错误，静默忽略
            }
        ).then(function() {
            setupTorch();
            setupFocus();
        }).catch(function(err) {
            console.error('启动摄像头失败:', err);
            showToast('启动摄像头失败：' + (err.message || err), '#f44336');
            stopScanner();
        });
    }).catch(function(err) {
        console.error('获取摄像头失败:', err);
        showToast('无法访问摄像头，请确认已授权', '#f44336');
        stopScanner();
    });
}

function stopScanner() {
    const modal = document.getElementById('scannerModal');
    if (modal) modal.style.display = 'none';

    scannerTorchOn = false;
    // 关掉弹窗后摄像头就停了，别让恢复连续对焦的定时器再动已失效的轨道
    if (focusRestoreTimer) { clearTimeout(focusRestoreTimer); focusRestoreTimer = null; }

    if (!html5QrCode) return;

    var scanner = html5QrCode;
    html5QrCode = null;
    try {
        scanner.stop().then(function() {
            scanner.clear();
        }).catch(function() {});
    } catch (e) {
        // 忽略停止扫码时的异常
    }
}

/* ============ 3. 存储后端：GitHub（GitHub Pages 版本使用） ============
 * 页面部署在 GitHub Pages 时，数据以 data.json 的形式存放在 GitHub 仓库里，
 * 通过 GitHub 官方 API 读写。不需要服务器，也没有过期时间。
 * ==================================================================== */

function ghHeaders() {
    const headers = { 'Accept': 'application/vnd.github+json' };
    if (ghToken) headers['Authorization'] = 'Bearer ' + ghToken;
    return headers;
}

// 首次使用：引导用户在本机保存一次访问令牌
async function ensureGhToken() {
    if (ghToken) return true;

    const token = window.prompt(
        '首次使用需要在本机保存一次 GitHub 访问令牌（Token）。\n\n' +
        '保存后以后都不用再填。\n\n' +
        '还没有令牌的话：\n' +
        'GitHub 右上角头像 → Settings → Developer settings →\n' +
        'Personal access tokens → Tokens (classic) →\n' +
        'Generate new token (classic)，勾选 repo 权限，生成后复制过来。'
    );

    if (!token || !token.trim()) {
        showToast('未填写令牌，暂时无法访问云端数据', '#ff9800');
        return false;
    }

    ghToken = token.trim();
    localStorage.setItem('ghToken', ghToken);
    showToast('令牌已保存到本机', '#4CAF50');
    return true;
}

// UTF-8 与 Base64 互转（GitHub API 以 Base64 传输文件内容）
function encodeBase64Utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function decodeBase64Utf8(b64) {
    const binary = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

// 读取仓库中的 data.json
async function ghLoad() {
    const url = GH_API + '/repos/' + GH_OWNER + '/' + GH_REPO +
                '/contents/' + GH_FILE + '?t=' + Date.now();

    const res = await fetch(url, { headers: ghHeaders(), cache: 'no-store' });

    if (res.status === 404) {
        ghSha = null;
        return { products: [], mappings: [] };
    }
    if (res.status === 401 || res.status === 403) {
        ghToken = '';
        localStorage.removeItem('ghToken');
        throw new Error('令牌无效或已过期，请重新填写');
    }
    if (!res.ok) {
        throw new Error('读取数据失败（HTTP ' + res.status + '）');
    }

    const json = await res.json();
    ghSha = json.sha;

    let parsed = {};
    try {
        parsed = JSON.parse(decodeBase64Utf8(json.content) || '{}');
    } catch (e) {
        parsed = {};
    }

    return {
        products: parsed.products || [],
        mappings: parsed.mappings || []
    };
}

// 把数据写回仓库中的 data.json（全量覆盖）
async function ghSave(newProducts, newMappings, message, isRetry) {
    const payload = JSON.stringify({
        products: newProducts,
        mappings: newMappings,
        updatedAt: new Date().toISOString()
    }, null, 2);

    const body = {
        message: message || ('更新数据 ' + new Date().toLocaleString('zh-CN')),
        content: encodeBase64Utf8(payload)
    };
    if (ghSha) body.sha = ghSha;

    const res = await fetch(
        GH_API + '/repos/' + GH_OWNER + '/' + GH_REPO + '/contents/' + GH_FILE,
        {
            method: 'PUT',
            headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
            body: JSON.stringify(body)
        }
    );

    // 版本冲突：重新读取最新版本后重试一次
    if (res.status === 409 && !isRetry) {
        await ghLoad();
        return ghSave(newProducts, newMappings, message, true);
    }
    if (res.status === 401 || res.status === 403) {
        ghToken = '';
        localStorage.removeItem('ghToken');
        throw new Error('令牌无效或已过期，请重新填写');
    }
    if (!res.ok) {
        const err = await res.json().catch(function() { return {}; });
        throw new Error(err.message || ('写入数据失败（HTTP ' + res.status + '）'));
    }

    const json = await res.json();
    ghSha = (json.content && json.content.sha) || ghSha;
    return json;
}

/* ===================== 4. CloudBase 初始化 ===================== */

// CloudBase SDK 有几百 KB，只在真的要用云端同步时才下载，避免拖慢首屏
const CB_SDK_URL = 'https://static.cloudbase.net/cloudbase-js-sdk/3.9.3/cloudbase.full.js';
let cbSdkLoading = null;

function loadScriptOnce(src) {
    if (cbSdkLoading) return cbSdkLoading;

    cbSdkLoading = new Promise(function(resolve, reject) {
        const script = document.createElement('script');
        script.src = src;
        script.onload = function() { resolve(true); };
        script.onerror = function() {
            cbSdkLoading = null;   // 允许下次重试
            reject(new Error('脚本加载失败：' + src));
        };
        document.head.appendChild(script);
    });

    return cbSdkLoading;
}

async function initCloudBase() {
    if (cloudReady) return true;

    if (!ENV_ID || ENV_ID === 'your-env-id') {
        console.warn('尚未配置 CloudBase 环境 ID，云端同步功能不可用');
        return false;
    }
    if (typeof cloudbase === 'undefined') {
        try {
            await loadScriptOnce(CB_SDK_URL);
        } catch (err) {
            console.error('CloudBase SDK 加载失败:', err);
            return false;
        }
    }
    if (typeof cloudbase === 'undefined') {
        console.error('CloudBase SDK 加载失败，云端同步不可用');
        return false;
    }

    try {
        const options = { env: ENV_ID };
        if (ACCESS_KEY) options.accessKey = ACCESS_KEY;

        cbApp = cloudbase.init(options);

        // 匿名登录（兼容 SDK 的不同版本写法）
        if (cbApp.auth && typeof cbApp.auth.signInAnonymously === 'function') {
            const res = await cbApp.auth.signInAnonymously();
            if (res && res.error) throw new Error(res.error.message || '匿名登录失败');
        } else if (typeof cbApp.auth === 'function') {
            await cbApp.auth({ persistence: 'local' }).anonymousAuthProvider().signIn();
        } else {
            throw new Error('当前 SDK 不支持匿名登录，请确认控制台已开启「匿名登录」');
        }

        cbDb = cbApp.database();
        cloudReady = true;
        console.log('CloudBase 初始化成功，环境：', ENV_ID);
    } catch (error) {
        cloudReady = false;
        console.error('CloudBase 初始化失败:', error);
        showToast('云端连接失败：' + (error.message || '未知错误'), '#f44336', 5000);
    }
    return cloudReady;
}

// 确保云端可用（未初始化则尝试初始化，并给出新手提示）
async function ensureCloud() {
    if (cloudReady) return true;

    const ok = await initCloudBase();
    if (!ok) {
        alert('云端尚未连接成功。\n\n请依次检查：\n' +
              '1. script.js 中的 ENV_ID 是否已替换为你的环境 ID\n' +
              '2. CloudBase 控制台是否已开启「匿名登录」\n' +
              '3. 数据库权限是否设置为「所有用户可读写」\n' +
              '4. 网络连接是否正常');
    }
    return ok;
}

// 分页拉取集合的全部数据
async function fetchAllFromCloud(collectionName) {
    const all = [];
    let skip = 0;

    while (true) {
        const res = await cbDb.collection(collectionName).skip(skip).limit(PAGE_SIZE).get();
        if (res && res.code) {
            throw new Error(res.message || ('查询失败：' + res.code));
        }
        const batch = (res && res.data) || [];
        all.push.apply(all, batch);
        if (batch.length < PAGE_SIZE) break;
        skip += PAGE_SIZE;
    }

    return all;
}

/* ===================== 4. 页面初始化 ===================== */
document.addEventListener('DOMContentLoaded', async function() {
    initializeApp();

    if (IS_GITHUB_PAGES) {
        // GitHub Pages 版本：数据存放在 GitHub 仓库，不使用 CloudBase
        console.log('运行于 GitHub Pages，数据存储：GitHub 仓库');
        return;
    }

    // CloudBase 版本：初始化云端连接，再启动实时数据监听
    await initCloudBase();
    startRealtimeWatch();
});

function initializeApp() {
    // 绑定事件监听器
    bindEventListeners();

    // 顶部标出这份页面在读写哪套数据，省得以为是「数据丢了 / 变回最初版本」
    renderStorageBadge();

    // 刚用网址参数切过数据源：本机缓存里还是另一套，提醒先拉一次
    if (storageModeFromUrl) {
        showToast('数据源已切换为 ' + storageModeLabel() +
                  '，建议先点「获取最新数据」', '#ff9800', 6000);
    }

    // 加载数据
    loadData();

    // 更新列表（顶部概览条也跟着刷，见 updateProductList 末尾）
    updateProductList();
    updateMappingList();

    // 打开页面就提醒已过期的商品（每天最多弹一次）
    alertExpiredOnce();

    // 确保添加商品表单默认为空
    try {
        const productForm = document.getElementById('productForm');
        if (productForm) {
            productForm.reset();
        }
    } catch (error) {
        console.error('重置表单失败:', error);
    }
}

// 当前这份数据存在哪儿（提示文案和顶部标签共用）
function storageModeLabel() {
    return IS_GITHUB_PAGES ? 'GitHub 仓库' : '腾讯云开发数据库';
}

// 页面标题下挂一个小标签，明示此刻读写的是哪套数据：
// 同一个页面部署在 GitHub Pages 和腾讯云两处，各自连的数据并不相同，
// 没有这个标签很容易把「另一套数据」误会成数据丢失或同步失败
function renderStorageBadge() {
    const header = document.querySelector('header');
    if (!header || header.querySelector('.storage-badge')) return;

    const badge = document.createElement('span');
    badge.className = 'storage-badge';
    badge.textContent = '数据源：' + storageModeLabel();
    header.appendChild(badge);
}

function bindEventListeners() {
    // 商品表单提交
    document.getElementById('productForm').addEventListener('submit', handleProductSubmit);

    // 条码输入变化
    document.getElementById('barcode').addEventListener('input', handleBarcodeChange);

    // 摄像头扫码
    const scanBtn = document.getElementById('scanBtn');
    if (scanBtn) scanBtn.addEventListener('click', startScanner);
    const stopScanBtn = document.getElementById('stopScanBtn');
    if (stopScanBtn) stopScanBtn.addEventListener('click', stopScanner);
    const torchBtn = document.getElementById('torchBtn');
    if (torchBtn) torchBtn.addEventListener('click', toggleTorch);

    // 点击遮罩关闭扫码弹窗
    const scannerModal = document.getElementById('scannerModal');
    if (scannerModal) {
        scannerModal.addEventListener('click', function(e) {
            if (e.target === scannerModal) stopScanner();
        });
    }

    // 生产日期或保质期变化时自动计算到期日期
    document.getElementById('productionDate').addEventListener('change', calculateExpiryDate);
    document.getElementById('shelfLife').addEventListener('input', calculateExpiryDate);

    // 导出CSV
    document.getElementById('exportBtn').addEventListener('click', exportToCSV);

    // 导入CSV
    document.getElementById('importBtn').addEventListener('click', function() {
        document.getElementById('importFile').click();
    });
    document.getElementById('importFile').addEventListener('change', importFromCSV);

    // 清空所有数据
    document.getElementById('clearBtn').addEventListener('click', clearAllData);

    // 同步数据到云端
    document.getElementById('syncBtn').addEventListener('click', syncData);

    // 从云端获取最新数据
    document.getElementById('fetchBtn').addEventListener('click', fetchLatestDataFromCloud);

    // 筛选1个月内到期商品
    document.getElementById('filterBtn').addEventListener('click', filterOneMonthExpiry);

    // 只看已处理的商品
    const handledFilterBtn = document.getElementById('handledFilterBtn');
    if (handledFilterBtn) handledFilterBtn.addEventListener('click', toggleHandledFilter);

    // 处置弹窗：确认 / 取消 / 点遮罩关闭，备注框里按回车直接确认
    const handleModal = document.getElementById('handleModal');
    if (handleModal) {
        handleModal.addEventListener('click', function(e) {
            if (e.target === handleModal) closeHandleDialog();
        });
    }
    const handleConfirmBtn = document.getElementById('handleConfirmBtn');
    if (handleConfirmBtn) handleConfirmBtn.addEventListener('click', confirmHandle);
    const handleCancelBtn = document.getElementById('handleCancelBtn');
    if (handleCancelBtn) handleCancelBtn.addEventListener('click', closeHandleDialog);
    const handleNoteInput = document.getElementById('handleNote');
    if (handleNoteInput) {
        handleNoteInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                confirmHandle();
            }
        });
    }

    // 添加映射
    document.getElementById('addMappingBtn').addEventListener('click', addMapping);

    // 商品列表搜索：输入即筛选
    bindLiveSearch('productSearch', 'productClearSearchBtn', function(value) {
        productSearchQuery = value.trim();
        updateProductList();
    });

    // 映射列表搜索：输入即筛选
    bindLiveSearch('mappingSearch', 'mappingClearSearchBtn', function(value) {
        mappingSearchQuery = value.trim();
        updateMappingList();
    });

    // 「添加商品」标题栏：展开 / 收起
    const addToggleBtn = document.getElementById('addToggleBtn');
    if (addToggleBtn) {
        addToggleBtn.addEventListener('click', function() {
            const form = document.getElementById('productForm');
            setAddFormOpen(!!form.hidden, true);
        });
    }
}

// 搜索框：输入即筛选，所以不再需要「搜索」按钮。
// 200ms 防抖是给手机留的余量 —— 每敲一个字都会重建整张表，记录多时连着重绘会卡；
// 回车则立即生效，不等防抖走完。
function bindLiveSearch(inputId, clearBtnId, onQuery) {
    const input = document.getElementById(inputId);
    if (!input) return;

    let timer = null;

    input.addEventListener('input', function() {
        clearTimeout(timer);
        timer = setTimeout(function() { onQuery(input.value); }, 200);
    });

    // 回车立刻筛，并取消防抖里那一次重复刷新
    input.addEventListener('keydown', function(e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        clearTimeout(timer);
        onQuery(input.value);
    });

    const clearBtn = document.getElementById(clearBtnId);
    if (clearBtn) {
        clearBtn.addEventListener('click', function() {
            clearTimeout(timer);
            input.value = '';
            onQuery('');
            input.focus();
        });
    }
}

// 展开 / 收起「添加商品」表单。
// 默认收起：常驻的表单在手机上要占掉近一整屏，而每次打开页面想看的是商品列表。
// focusBarcode 为 true 时才聚焦条码框并滚过去 —— 手机上键盘弹起来会盖住表单，
// 所以「从列表点编辑」那条路径不聚焦（见 setEditMode）。
function setAddFormOpen(open, focusBarcode) {
    const section = document.getElementById('addSection');
    const form = document.getElementById('productForm');
    const btn = document.getElementById('addToggleBtn');
    if (!form || !section) return;

    form.hidden = !open;
    section.classList.toggle('collapsed', !open);
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');

    if (!open || !focusBarcode) return;

    const barcodeInput = document.getElementById('barcode');
    if (barcodeInput) barcodeInput.focus();

    // 收起状态下标题栏就在列表下面，一般不用滚；block: 'nearest' 保证
    // 已经在屏幕里时不会有任何跳动，真的在屏幕外才滚
    section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ===================== 5. 商品表单 ===================== */
// 处理条码输入变化
function handleBarcodeChange() {
    const barcode = document.getElementById('barcode').value.trim();
    const productNameInput = document.getElementById('productName');

    // 查找映射
    const mapping = productMappings.find(function(item) { return item.barcode === barcode; });
    // 只有查到映射才覆盖名称；查不到时保留手填内容，不要清空
    if (mapping) productNameInput.value = mapping.productName;
}

// 计算到期日期（保质期支持 天 / 月 / 年）
function calculateExpiryDate() {
    const productionDate = parseDateLocal(document.getElementById('productionDate').value);
    const shelfLifeInput = document.getElementById('shelfLife');
    const unitInput = document.getElementById('shelfLifeUnit');
    const validityInput = document.getElementById('validity');

    if (!productionDate) return;

    const amount = parseInt(shelfLifeInput.value, 10);
    if (!amount || amount <= 0) return;

    const unit = unitInput ? unitInput.value : '月';
    let expiry;

    if (unit === '天') {
        // 鲜奶、面包这类按天算的保质期
        expiry = new Date(productionDate.getTime());
        expiry.setDate(expiry.getDate() + amount);
    } else if (unit === '年') {
        expiry = addMonthsClamped(productionDate, amount * 12);
    } else {
        expiry = addMonthsClamped(productionDate, amount);
    }

    validityInput.value = formatDateLocal(expiry);
}

// 从表单里取字段，拼成一条完整的新记录。
// 「添加商品」和「编辑」共用这一份逻辑，保证两边生成的字段不会写歪。
function buildProductFromForm(formData, shelfLifeUnit) {
    return {
        uid: makeUid(),        // 唯一标识：同条码的不同批次靠它区分，同步时不会互相覆盖
        id: Date.now() + Math.floor(Math.random() * 1000),
        barcode: formData.get('barcode'),
        productName: formData.get('productName'),
        type: '商品',          // 默认类型为"商品"
        scanDate: todayLocal(), // 按本地日期记录，避免晚上录入被记成前一天
        productionDate: formData.get('productionDate'),
        shelfLife: formData.get('shelfLife'),
        shelfLifeUnit: shelfLifeUnit,
        validity: formData.get('validity'),
        updatedAt: new Date().toISOString(),   // 合并时判新旧用；新记录这就是它的第一次修改
        createdAt: new Date().toISOString()
    };
}

// 处理商品表单提交
// 「添加」和「编辑」走同一套逻辑：都往 products 里 push 一条新记录。
// 编辑 = 重新添加一条：uid、扫描日期、类型、创建时间全部按新记录生成，
// 原来那条记录原样保留 —— 不做原地覆盖，同一条码的不同批次可以各留一条。
function handleProductSubmit(e) {
    e.preventDefault();

    const formData = new FormData(e.target);
    const editingId = e.target.dataset.editingId;   // 有值 = 从列表里点过「编辑」

    const shelfLifeUnitInput = document.getElementById('shelfLifeUnit');
    const shelfLifeUnit = shelfLifeUnitInput ? shelfLifeUnitInput.value : '月';

    products.push(buildProductFromForm(formData, shelfLifeUnit));

    saveProducts();
    updateProductList();
    updateReminder();

    resetProductForm();

    alert(editingId ? '已按修改后的内容新增一条记录，原来那条仍保留在列表里。' : '商品添加成功！');
}

// 把商品表单恢复成「添加商品」的初始状态：
// 清空输入、撤掉编辑标记、提交按钮文字复原、收起「取消编辑」按钮。
function resetProductForm() {
    const form = document.getElementById('productForm');
    if (!form) return;

    form.reset();
    delete form.dataset.editingId;

    const submitBtn = document.querySelector('#productForm button[type="submit"]');
    if (submitBtn) submitBtn.textContent = '添加商品';

    const cancelBtn = document.getElementById('cancelEditBtn');
    if (cancelBtn) cancelBtn.style.display = 'none';
}

// 保存商品数据
function saveProducts() {
    localStorage.setItem('products', JSON.stringify(products));
}

// 保存映射数据
function saveMappings() {
    localStorage.setItem('productMappings', JSON.stringify(productMappings));
}

// 保存删除标记（墓碑）
function saveTombstones() {
    localStorage.setItem('productTombstones', JSON.stringify(productTombstones));
    localStorage.setItem('mappingTombstones', JSON.stringify(mappingTombstones));
}

/* ===================== 5.5 处置状态（保留原始记录，不删除） ===================== */
// 过期/用不上的商品不删掉，只在记录上挂一份处置信息：
//   handledAt     处置日期（有值即视为已处理；老数据没这个字段 = 未处理，无需迁移）
//   handledAction 处置方式，取自下面的预设分类
//   handledNote   备注，可留空
// 条码、生产日期、有效期这些原始字段一个都不动，随时可以撤销回到待处理。
const HANDLE_ACTIONS = ['已用完', '已丢弃', '已退换', '其他'];

// 是否已处理
function isHandled(product) {
    return !!(product && product.handledAt);
}

// 处置信息摘要，例如「已丢弃 · 2026-09-12 · 长毛了整箱扔」
function formatHandledInfo(product) {
    const parts = [
        product.handledAction || '已处理',
        product.handledAt || '',
        product.handledNote || ''
    ];
    return parts.filter(function(part) { return !!part; }).join(' · ');
}

// 按 uid 找商品（老记录兜底用数字 id）
function findProductByKey(id) {
    let product = products.find(function(p) { return p.uid && String(p.uid) === String(id); });
    if (!product) product = products.find(function(p) { return String(p.id) === String(id); });
    return product;
}

/* ===================== 6. 列表渲染 ===================== */

// 防止导入的 CSV 里带有 HTML 破坏页面
function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// 保质期显示，例如“12个月”“7天”；旧数据没有单位时按“月”处理
function formatShelfLife(product) {
    if (!product || !product.shelfLife) return '-';
    const unit = product.shelfLifeUnit || '月';
    return product.shelfLife + (unit === '月' ? '个月' : unit);
}

// 更新商品列表
function updateProductList() {
    const tbody = document.querySelector('#productTable tbody');
    tbody.innerHTML = '';

    // 获取要显示的商品列表
    let displayProducts = products.slice();

    if (currentDisplayMode === 'handled') {
        // 「显示已处理」模式：只看处理过的
        displayProducts = displayProducts.filter(isHandled);
    } else if (currentDisplayMode === 'filter') {
        // 筛选模式：只显示1个月内到期的未处理商品
        displayProducts = displayProducts.filter(function(product) {
            if (isHandled(product)) return false;
            const status = getExpiryStatus(product.validity);
            return status === 'danger' || status === 'expired';
        });
    } else {
        // 默认模式：已处理的隐藏起来；
        // 但搜索时要把它们带出来，否则「处理过的东西搜不到」很反直觉
        displayProducts = displayProducts.filter(function(product) {
            return !isHandled(product) || !!productSearchQuery;
        });
    }

    // 应用搜索过滤
    if (productSearchQuery) {
        const query = productSearchQuery.toLowerCase();
        displayProducts = displayProducts.filter(function(p) {
            return (p.productName || '').toLowerCase().includes(query) ||
                   (p.barcode || '').includes(query);
        });
    }

    // 按到期日期排序：已过期 / 快到期排前面，没填有效期的排最后；
    // 已处理的统一沉到最底下（搜索时才会和未处理的混在一起显示）
    const sortedProducts = displayProducts.sort(function(a, b) {
        const handledA = isHandled(a);
        const handledB = isHandled(b);
        if (handledA !== handledB) return handledA ? 1 : -1;

        const da = parseDateLocal(a.validity);
        const db = parseDateLocal(b.validity);
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return da - db;
    });

    // 一条都没有时给句提示，否则「已处理默认隐藏」会让人误以为数据丢了
    if (sortedProducts.length === 0) {
        let tip = '没有符合条件的商品';
        if (currentDisplayMode === 'handled') {
            tip = '还没有标记过处理的商品';
        } else if (products.length > 0) {
            tip = '没有待处理的商品（处理过的默认隐藏，可点「显示已处理」查看）';
        }
        const emptyRow = document.createElement('tr');
        emptyRow.innerHTML = '<td colspan="10" class="empty-tip">' + tip + '</td>';
        tbody.appendChild(emptyRow);

        // 列表变了，顶部的到期提醒和概览条跟着刷新
        updateReminder();
        updateStatsStrip();
        return;
    }

    sortedProducts.forEach(function(product, index) {
        const row = document.createElement('tr');
        const handled = isHandled(product);
        const status = getExpiryStatus(product.validity);

        // 筛选模式下高亮显示关键信息
        let nameStyle = '';
        let validityStyle = '';
        let actionStyle = '';
        if (currentDisplayMode === 'filter') {
            nameStyle = ' style="font-weight: bold; color: red;"';
            validityStyle = ' style="font-weight: bold; color: red;"';
            actionStyle = ' style="font-weight: bold;"';
        }

        // 已过期 / 30 天内到期的整行加底色，配合末尾的排序做到「临期置顶一眼可见」
        // 已处理的只用灰色压暗，不再用红黄底色（它已经不是待办了）
        if (handled) row.classList.add('row-handled');
        else if (status === 'expired') row.classList.add('row-expired');
        else if (status === 'danger') row.classList.add('row-danger');

        const rowKey = product.uid || product.id;

        // 状态列：已处理的显示处置标记，未处理的显示还剩/过期几天
        const statusCell = handled
            ? '<span class="status status-handled">已处理</span>'
            : '<span class="status status-' + status + '">' + getStatusLabel(product.validity) + '</span>';

        // 名称列：已处理的在下面补一行「处置方式 · 日期 · 备注」
        const nameCell = handled
            ? escapeHtml(product.productName) + '<div class="handled-note">' + escapeHtml(formatHandledInfo(product)) + '</div>'
            : escapeHtml(product.productName);

        // 操作列：三个按钮收进一个下拉框，宽度从 ~140px 降到 ~70px，
        // 手机上才不会把「商品名称」整列挤出屏幕。
        // 用原生 <select> 而不是自定义弹层：表格容器是 overflow:auto，
        // 绝对定位的菜单会被裁掉，而原生 select 的选项列表由系统绘制，不受影响。
        // 选项文字统一两个字；「撤销」= 撤销处置标记（只有已处理的行才有这一项）。
        //
        // 第一个 option 是占位项：value="" 不带任何动作，只负责「收起状态」显示两个汉字，
        // hidden 让它在弹出的选项列表里不出现（列表里就只有下面那三项）。
        // 之所以必须留占位项、不能直接把「编辑」设成默认选中项：浏览器只在值变化时触发
        // change，若「编辑」本身就是选中项，用户再选它不会有任何事件，点了像坏了一样。
        // 占位项用 hidden 而不是 disabled —— disabled 的选中项在某些浏览器里会渲染成灰色。
        const placeholder = handled ? '撤销' : '编辑';
        const actions =
            '<select class="action-select" data-key="' + escapeHtml(rowKey) + '"' +
                    ' onchange="handleRowAction(this)">' +
                '<option value="" selected hidden>' + placeholder + '</option>' +
                (handled
                    ? '<option value="undo">撤销</option>'
                    : '<option value="handle">处理</option>' +
                      '<option value="edit">编辑</option>') +
                '<option value="delete">删除</option>' +
            '</select>';

        // 单元格顺序必须和 index.html 里 productTable 的表头一致：操作在最左
        row.innerHTML = `
            <td${actionStyle}>${actions}</td>
            <td>${index + 1}</td>
            <td${validityStyle}>${escapeHtml(product.validity) || '-'}</td>
            <td>${statusCell}</td>
            <td${nameStyle}>${nameCell}</td>
            <td>${escapeHtml(product.type)}</td>
            <td>${escapeHtml(product.scanDate)}</td>
            <td>${escapeHtml(product.productionDate) || '-'}</td>
            <td>${formatShelfLife(product)}</td>
            <td>${escapeHtml(product.barcode)}</td>
        `;

        tbody.appendChild(row);
    });

    // 列表变了，顶部的到期提醒和概览条跟着刷新
    updateReminder();
    updateStatsStrip();
}

// 两个筛选按钮（临期筛选 / 显示已处理）互斥，文案和配色统一在这里同步
function syncFilterButtons() {
    const filterBtn = document.getElementById('filterBtn');
    if (filterBtn) {
        const on = currentDisplayMode === 'filter';
        filterBtn.textContent = on ? '显示所有商品' : '筛选1个月内到期商品';
        filterBtn.classList.toggle('btn-success', on);
        filterBtn.classList.toggle('btn-warning', !on);
    }

    const handledBtn = document.getElementById('handledFilterBtn');
    if (handledBtn) {
        const on = currentDisplayMode === 'handled';
        handledBtn.textContent = on ? '返回待处理' : '显示已处理';
        handledBtn.classList.toggle('btn-success', on);
        handledBtn.classList.toggle('btn-secondary', !on);
    }
}

// 筛选1个月内到期的商品
function filterOneMonthExpiry() {
    currentDisplayMode = currentDisplayMode === 'filter' ? 'all' : 'filter';
    syncFilterButtons();
    updateProductList();
}

// 只看已处理的商品
function toggleHandledFilter() {
    currentDisplayMode = currentDisplayMode === 'handled' ? 'all' : 'handled';
    syncFilterButtons();
    updateProductList();
}

// 距离到期还有多少天（按本地日历日算：今天到期是 0，昨天到期是 -1）
function getDaysLeft(validity) {
    const expiry = parseDateLocal(validity);
    if (!expiry) return null;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((expiry - today) / 86400000);
}

// 获取到期状态
function getExpiryStatus(validity) {
    const days = getDaysLeft(validity);
    if (days === null) return 'unknown';   // 没填有效期，不能当成“正常”
    if (days < 0) return 'expired';
    if (days <= 30) return 'danger';
    if (days <= 90) return 'warning';
    return 'normal';
}

// 获取状态文本
function getStatusText(status) {
    const statusMap = {
        normal: '正常',
        warning: '1-3个月',
        danger: '1个月内',
        expired: '已过期',
        unknown: '无有效期'
    };
    return statusMap[status] || status;
}

// 列表状态列用的短标签：直接写“还剩几天”，比“1个月内”更直观
function getStatusLabel(validity) {
    const days = getDaysLeft(validity);
    if (days === null) return '未填有效期';
    if (days < 0) return '过期' + Math.abs(days) + '天';
    if (days === 0) return '今天到期';
    return '剩' + days + '天';
}

/* ===================== 6.1 到期提醒 ===================== */

const REMIND_ALERT_KEY = 'lastExpiryAlertDate';   // 已过期的弹窗每天最多一次
const REMIND_HIDE_KEY = 'reminderHiddenDate';     // 点过「知道了」当天不再显示横幅

// 统计当前有多少商品需要提醒
function getReminderSummary() {
    const summary = { expired: 0, danger: 0, expiredList: [], dangerList: [] };

    products.forEach(function(product) {
        // 已处理的商品不再进提醒，否则处理完了横幅还天天挂着，等于白处理
        if (isHandled(product)) return;

        const status = getExpiryStatus(product.validity);
        if (status === 'expired') {
            summary.expired++;
            summary.expiredList.push(product);
        } else if (status === 'danger') {
            summary.danger++;
            summary.dangerList.push(product);
        }
    });

    return summary;
}

// 把商品列表拼成「名称（有效期）」形式，最多列 5 条
function reminderNames(list, total) {
    const names = list.slice(0, 5).map(function(product) {
        return (product.productName || product.barcode || '未命名') +
               '（' + (product.validity || '无有效期') + '）';
    }).join('、');
    return names + (total > 5 ? ' 等' : '');
}

// 渲染顶部提醒条；没有临期/过期商品时自动隐藏
function updateReminder() {
    const banner = document.getElementById('reminderBanner');
    if (!banner) return;

    const summary = getReminderSummary();
    const hasUrgent = summary.expired > 0 || summary.danger > 0;

    // 点过「知道了」当天不再打扰
    if (!hasUrgent || localStorage.getItem(REMIND_HIDE_KEY) === todayLocal()) {
        banner.style.display = 'none';
        banner.innerHTML = '';
        return;
    }

    let html = '<div class="reminder-title">保质期提醒</div><div class="reminder-body">';

    if (summary.expired > 0) {
        html += '<span class="reminder-item reminder-item-expired">已过期 ' + summary.expired + ' 项：' +
                escapeHtml(reminderNames(summary.expiredList, summary.expired)) + '</span>';
    }
    if (summary.danger > 0) {
        html += '<span class="reminder-item reminder-item-danger">30 天内到期 ' + summary.danger + ' 项：' +
                escapeHtml(reminderNames(summary.dangerList, summary.danger)) + '</span>';
    }

    html += '</div><div class="reminder-actions">' +
            '<button type="button" class="btn btn-warning" id="reminderFilterBtn">只看这些</button>' +
            '<button type="button" class="btn btn-secondary" id="reminderCloseBtn">知道了</button>' +
            '</div>';

    banner.className = 'reminder-banner' + (summary.expired > 0 ? ' reminder-banner-expired' : '');
    banner.innerHTML = html;
    banner.style.display = 'block';

    // 「只看这些」：切到筛选模式，并同步底部主按钮的状态
    const filterBtn = document.getElementById('reminderFilterBtn');
    if (filterBtn) {
        filterBtn.addEventListener('click', function() {
            currentDisplayMode = 'filter';
            syncFilterButtons();
            updateProductList();
            const table = document.getElementById('productTable');
            if (table) table.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }

    const closeBtn = document.getElementById('reminderCloseBtn');
    if (closeBtn) {
        closeBtn.addEventListener('click', function() {
            localStorage.setItem(REMIND_HIDE_KEY, todayLocal());
            banner.style.display = 'none';
        });
    }
}

// 打开页面时，如果已经有商品过期，弹一次醒目提示（每天最多一次，免得天天被烦）
function alertExpiredOnce() {
    const summary = getReminderSummary();
    if (summary.expired === 0) return;
    if (localStorage.getItem(REMIND_ALERT_KEY) === todayLocal()) return;

    localStorage.setItem(REMIND_ALERT_KEY, todayLocal());

    const names = summary.expiredList.slice(0, 5).map(function(product) {
        return '· ' + (product.productName || product.barcode || '未命名') +
               '（有效期 ' + (product.validity || '未填') + '）';
    }).join('\n');

    alert('有 ' + summary.expired + ' 项商品已过期，请尽快处理：\n\n' + names +
          (summary.expired > 5 ? '\n… 共 ' + summary.expired + ' 项' : ''));
}

// 更新映射列表
function updateMappingList() {
    const tbody = document.querySelector('#mappingTable tbody');
    tbody.innerHTML = '';

    let displayMappings = productMappings.slice();

    // 应用搜索过滤
    if (mappingSearchQuery) {
        const query = mappingSearchQuery.toLowerCase();
        displayMappings = displayMappings.filter(function(m) {
            return (m.productName || '').toLowerCase().includes(query) ||
                   (m.barcode || '').includes(query);
        });
    }

    displayMappings.forEach(function(mapping, index) {
        const row = document.createElement('tr');

        row.innerHTML = `
            <td>${index + 1}</td>
            <td>${mapping.barcode}</td>
            <td>${mapping.productName}</td>
            <td>
                <button class="btn btn-secondary" onclick="editMapping('${mapping.id}')">编辑</button>
                <button class="btn btn-danger" onclick="deleteMapping('${mapping.id}')">删除</button>
            </td>
        `;

        tbody.appendChild(row);
    });
}

/* ===================== 7. 编辑 / 删除 ===================== */
// 编辑商品（全局函数，以便HTML onclick事件调用）
window.editProduct = function(id) {
    // 优先按 uid 找，兼容老记录的数字 id
    let product = products.find(function(p) { return p.uid && String(p.uid) === String(id); });
    if (!product) product = products.find(function(p) { return String(p.id) === String(id); });

    if (!product) {
        alert('未找到指定商品');
        return;
    }

    try {
        document.getElementById('barcode').value = product.barcode;
        document.getElementById('productName').value = product.productName;
        document.getElementById('productionDate').value = product.productionDate;
        document.getElementById('shelfLife').value = product.shelfLife;

        const unitInput = document.getElementById('shelfLifeUnit');
        if (unitInput) unitInput.value = product.shelfLifeUnit || '月';

        document.getElementById('validity').value = product.validity;

        // 设置编辑模式
        setEditMode(id);

        // 表单在列表上方：手机上不滚过去的话，点完「编辑」屏幕毫无反应，会以为坏了
        const formSection = document.querySelector('.form-section');
        if (formSection) formSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
        console.error('编辑功能执行失败:', error);
    }
};

// 操作列下拉框的分发：选中即执行，然后把选择复位回占位项。
// 复位是必须的 —— 浏览器只在值发生变化时触发 change，
// 不复位的话连着两次选「编辑」，第二次会因为值没变而完全没反应。
window.handleRowAction = function(select) {
    const key = select.dataset.key;
    const action = select.value;

    select.value = '';

    if (action === 'edit') editProduct(key);
    else if (action === 'handle') openHandleDialog(key);
    else if (action === 'undo') undoHandle(key);
    else if (action === 'delete') deleteProduct(key);
};

// 切换商品表单的「添加 / 编辑」两种状态。
// 编辑状态下提交按钮改成「保存为新记录」——编辑不再原地覆盖而是新增一条，
// 按钮上继续写「更新商品」就是在骗人。
function setEditMode(editingId) {
    const form = document.getElementById('productForm');
    if (!form) return;

    if (editingId) form.dataset.editingId = editingId;
    else delete form.dataset.editingId;

    const submitBtn = document.querySelector('#productForm button[type="submit"]');
    if (submitBtn) submitBtn.textContent = editingId ? '保存为新记录' : '添加商品';

    const cancelBtn = document.getElementById('cancelEditBtn');
    if (cancelBtn) cancelBtn.style.display = editingId ? 'inline-block' : 'none';

    // 表单默认收起：从列表点「编辑」时要把它展开，否则字段被填进一个看不见的表单，
    // 用户只看到列表毫无变化，会以为点坏了（editProduct 里已经负责滚过去）
    if (editingId) setAddFormOpen(true, false);
}

// 取消编辑：把表单和编辑状态清干净（点过「编辑」之后原来是没有退路的）
window.cancelEdit = function() {
    resetProductForm();
    showToast('已取消编辑', '#9e9e9e');
};

// 删除商品（全局函数，以便HTML onclick事件调用）
window.deleteProduct = function(id) {
    if (!confirm('确定要删除这个商品吗？')) return;

    // 按 uid 定位（老记录兜底用 id），只删这一条，同条码的其他批次不受影响
    function isTarget(p) {
        return String(p.uid) === String(id) || String(p.id) === String(id);
    }

    const productToDelete = products.find(isTarget);
    if (!productToDelete) {
        showToast('没找到这条记录，可能已经被删掉了', '#ff9800');
        return;
    }

    // 留一条墓碑，而不是从云端直接抹掉：
    // 抹掉之后就再没有任何线索能说明「这条是被删的」，
    // 别的设备手里那份旧副本一同步就会把它原样带回来
    const deletedAt = new Date().toISOString();
    productTombstones.push(makeProductTombstone(productToDelete, deletedAt));

    products = products.filter(function(p) { return !isTarget(p); });

    saveProducts();
    saveTombstones();
    updateProductList();
    updateReminder();

    // 墓碑立刻推到云端，别的设备下次「获取最新数据」就能看到这条没了。
    // 推失败也无所谓：本机已经删掉了，下次点「同步」会补上
    pushTombstonesQuietly();
};

/* ===================== 8.1 标记处理 / 撤销处理 ===================== */
// 当前正在处置的商品（弹窗点确认时用）
let handleTargetKey = null;

// 打开处置弹窗
window.openHandleDialog = function(id) {
    const product = findProductByKey(id);
    if (!product) {
        alert('未找到指定商品');
        return;
    }

    const modal = document.getElementById('handleModal');
    if (!modal) return;

    handleTargetKey = id;

    const nameEl = document.getElementById('handleProductName');
    if (nameEl) {
        nameEl.textContent = (product.productName || product.barcode || '未命名') +
            (product.validity ? '（有效期 ' + product.validity + '）' : '');
    }

    const actionEl = document.getElementById('handleAction');
    if (actionEl) actionEl.value = product.handledAction || HANDLE_ACTIONS[0];

    const noteEl = document.getElementById('handleNote');
    if (noteEl) noteEl.value = product.handledNote || '';

    modal.style.display = 'flex';
};

// 关闭处置弹窗
function closeHandleDialog() {
    const modal = document.getElementById('handleModal');
    if (modal) modal.style.display = 'none';
    handleTargetKey = null;
}

// 确认处置：只在记录上挂标记，不删除任何原始字段
window.confirmHandle = function() {
    const product = findProductByKey(handleTargetKey);
    if (!product) {
        closeHandleDialog();
        return;
    }

    const actionEl = document.getElementById('handleAction');
    const noteEl = document.getElementById('handleNote');

    product.handledAction = actionEl ? actionEl.value : HANDLE_ACTIONS[0];
    product.handledNote = noteEl ? noteEl.value.trim() : '';
    product.handledAt = todayLocal();
    touchRecord(product);   // 打了这个时间戳，别的设备才知道这条比它手里的新

    closeHandleDialog();

    saveProducts();
    updateProductList();
    updateReminder();

    showToast('已标记为「' + product.handledAction + '」，原始记录保留', '#4CAF50');
};

// 撤销处置：清掉标记，商品回到待处理列表
window.undoHandle = function(id) {
    const product = findProductByKey(id);
    if (!product) {
        alert('未找到指定商品');
        return;
    }

    const label = product.handledAction || '已处理';
    if (!confirm('撤销「' + label + '」标记，让它回到待处理列表？\n（商品记录一直都在，撤销只是清掉这个标记）')) {
        return;
    }

    product.handledAction = '';
    product.handledNote = '';
    product.handledAt = '';
    // 撤销同样要打时间戳，否则别处那份「已处理」会被判成更新，撤销推不过去
    touchRecord(product);

    saveProducts();
    updateProductList();
    updateReminder();

    showToast('已撤销处理标记，商品回到待处理列表', '#2196F3');
};

// 添加映射
function addMapping() {
    const barcode = document.getElementById('newBarcode').value;
    const productName = document.getElementById('newProductName').value;
    const addMappingBtn = document.getElementById('addMappingBtn');
    const isEditing = addMappingBtn.dataset.editingId;

    if (!barcode || !productName) {
        alert('请填写完整的条码和商品名称！');
        return;
    }

    if (isEditing) {
        // 编辑模式：更新现有映射
        const mappingId = isEditing;
        const mappingIndex = productMappings.findIndex(function(m) { return m.id == mappingId; });

        if (mappingIndex !== -1) {
            const oldBarcode = productMappings[mappingIndex].barcode;
            productMappings[mappingIndex] = Object.assign({}, productMappings[mappingIndex], {
                barcode: barcode,
                productName: productName,
                updatedAt: new Date().toISOString()
            });

            // 如果条码发生变化，需要更新商品列表中所有使用旧条码的商品名称
            if (oldBarcode !== barcode) {
                syncProductNames(oldBarcode, productName);
            }
            syncProductNames(barcode, productName);

            saveMappings();
            updateMappingList();
            updateProductList();

            document.getElementById('newBarcode').value = '';
            document.getElementById('newProductName').value = '';

            delete addMappingBtn.dataset.editingId;
            addMappingBtn.textContent = '添加映射';

            alert('映射更新成功！');
        }
    } else {
        // 添加模式：创建新映射或更新现有映射
        const existingIndex = productMappings.findIndex(function(m) { return m.barcode === barcode; });

        if (existingIndex >= 0) {
            // 更新现有映射
            productMappings[existingIndex].productName = productName;
            touchRecord(productMappings[existingIndex]);
            syncProductNames(barcode, productName);
        } else {
            // 添加新映射
            productMappings.push({
                id: Date.now(),
                barcode: barcode,
                productName: productName,
                updatedAt: new Date().toISOString()
            });
        }

        saveMappings();
        updateMappingList();

        document.getElementById('newBarcode').value = '';
        document.getElementById('newProductName').value = '';

        alert('映射保存成功！');
    }
}

// 同步商品名称
function syncProductNames(barcode, newName) {
    products.forEach(function(product) {
        if (product.barcode === barcode) {
            product.productName = newName;
            touchRecord(product);   // 改名也是一次修改，别的设备要能收到
        }
    });
    saveProducts();
    updateProductList();
}

// 编辑映射（全局函数，以便HTML onclick事件调用）
window.editMapping = function(id) {
    let mapping = productMappings.find(function(m) { return m.id === id; });
    if (!mapping) mapping = productMappings.find(function(m) { return m.id == id; });
    if (!mapping) mapping = productMappings.find(function(m) { return String(m.id) === String(id); });

    if (!mapping) {
        alert('未找到指定映射');
        return;
    }

    try {
        document.getElementById('newBarcode').value = mapping.barcode;
        document.getElementById('newProductName').value = mapping.productName;

        document.getElementById('addMappingBtn').dataset.editingId = id;
        document.getElementById('addMappingBtn').textContent = '更新映射';
    } catch (error) {
        console.error('映射编辑功能执行失败:', error);
    }
};

// 删除映射（全局函数，以便HTML onclick事件调用）
window.deleteMapping = function(id) {
    if (!confirm('确定要删除这个映射吗？')) return;

    const mappingToDelete = productMappings.find(function(m) { return m.id == id; });
    if (!mappingToDelete) {
        showToast('没找到这个映射，可能已经被删掉了', '#ff9800');
        return;
    }

    // 和商品一样留墓碑：不然别的设备一同步，这个映射又回来了
    const deletedAt = new Date().toISOString();
    mappingTombstones.push(makeMappingTombstone(mappingToDelete, deletedAt));

    productMappings = productMappings.filter(function(m) { return m.id != id; });
    saveMappings();
    saveTombstones();
    updateMappingList();

    pushTombstonesQuietly();
};

/* ===================== 8. CSV 导入导出 ===================== */
// CSV 单元格转义：内部引号加倍，否则商品名里带逗号会把列冲错
function csvCell(value) {
    const text = value === undefined || value === null ? '' : String(value);
    return '"' + text.replace(/"/g, '""') + '"';
}

// 导出CSV（商品 + 映射，导出文件本身就是一份完整备份）
function exportToCSV() {
    if (products.length === 0 && productMappings.length === 0) {
        alert('没有数据可以导出！');
        return;
    }

    // 处置相关的 3 列追加在最后：导入时按位置读前 8 列，追加不会破坏老文件的兼容性
    const headers = ['类型', '商品条码', '商品名称', '扫描日期', '有效期', '生产日期', '保质期', '状态',
                     '处置方式', '处置日期', '处置备注'];
    const rows = [];

    products.forEach(function(product) {
        const shelfLife = formatShelfLife(product);
        rows.push([
            product.type || '商品',
            product.barcode,
            product.productName,
            product.scanDate,
            product.validity,
            product.productionDate || '',
            shelfLife === '-' ? '' : shelfLife,
            getStatusText(getExpiryStatus(product.validity)),
            product.handledAction || '',
            product.handledAt || '',
            product.handledNote || ''
        ]);
    });

    // 映射也一起导出，否则换台设备映射就全丢了
    productMappings.forEach(function(mapping) {
        rows.push(['映射', mapping.barcode, mapping.productName, '', '', '', '', '', '', '', '']);
    });

    const csvContent = [
        headers.join(','),
        ...rows.map(function(row) {
            return row.map(csvCell).join(',');
        })
    ].join('\n');

    // 前面加 UTF-8 BOM（0xFEFF），否则 Excel 打开中文会乱码
    const blob = new Blob([String.fromCharCode(65279) + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);

    link.setAttribute('href', url);
    link.setAttribute('download', '商品到期提醒_' + todayLocal() + '.csv');
    link.style.visibility = 'hidden';

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// 解析CSV文本：正确处理引号包裹、引号内的逗号和换行
function parseCsvText(text) {
    const QUOTE = 34;   // "
    const COMMA = 44;   // ,
    const LF = 10;      // 换行
    const CR = 13;      // 回车

    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);

        if (inQuotes) {
            if (code === QUOTE) {
                if (text.charCodeAt(i + 1) === QUOTE) { field += '"'; i++; }
                else inQuotes = false;
            } else {
                field += text[i];
            }
        } else if (code === QUOTE) {
            inQuotes = true;
        } else if (code === COMMA) {
            row.push(field); field = '';
        } else if (code === LF) {
            row.push(field); rows.push(row); row = []; field = '';
        } else if (code !== CR) {
            field += text[i];
        }
    }

    if (field !== '' || row.length > 0) {
        row.push(field);
        rows.push(row);
    }

    return rows.filter(function(r) {
        return r.some(function(c) { return String(c).trim() !== ''; });
    });
}

// 去掉文件开头的 BOM，否则第一列“类型”识别不出来
function stripBom(text) {
    return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

// 把“7天”“12个月”“3年”“12”这样的保质期文本拆成 数量 + 单位
function parseShelfLifeText(text) {
    const raw = String(text || '').trim();
    const m = /^(\d+(?:\.\d+)?)\s*(天|日|周|个月|月|年)?/.exec(raw);
    if (!m) return { shelfLife: '', shelfLifeUnit: '月' };

    let value = Number(m[1]);
    let unit = m[2] || '月';
    if (unit === '日') unit = '天';
    if (unit === '周') { unit = '天'; value = value * 7; }
    if (unit === '个月') unit = '月';

    return { shelfLife: String(parseInt(value, 10)), shelfLifeUnit: unit };
}

// 导入CSV
function importFromCSV(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(event) {
        const csvContent = stripBom(String(event.target.result || ''));
        const rows = parseCsvText(csvContent);

        if (rows.length < 2) {
            alert('CSV文件格式不正确！');
            return;
        }

        let productCount = 0;
        let mappingCount = 0;

        // 跳过表头，顺序：类型、商品条码、商品名称、扫描日期、有效期、生产日期、保质期、状态、处置方式、处置日期、处置备注
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const type = (row[0] || '').trim();
            const barcode = (row[1] || '').trim();
            const productName = (row[2] || '').trim();

            if (!barcode) continue;

            if (type === '商品') {
                const shelf = parseShelfLifeText(row[6]);

                // 处置信息在最后 3 列。老备份文件没有这几列，读出来是空，按未处理处理
                const handledAction = (row[8] || '').trim();
                let handledAt = (row[9] || '').trim();
                // 只有处置方式、没有日期时补今天；不然 handledAt 为空会被当成未处理，进不了已处理列表
                if (handledAction && !handledAt) handledAt = todayLocal();

                products.push({
                    uid: makeUid(),      // 导入的记录也要有 uid，否则同步时无法与云端一一对应
                    id: Date.now() + i,
                    type: '商品',
                    barcode: barcode,
                    productName: productName,
                    scanDate: (row[3] || '').trim(),
                    validity: (row[4] || '').trim(),
                    productionDate: (row[5] || '').trim(),
                    shelfLife: shelf.shelfLife,
                    shelfLifeUnit: shelf.shelfLifeUnit,
                    handledAction: handledAction,
                    handledAt: handledAt,
                    handledNote: (row[10] || '').trim(),
                    updatedAt: new Date().toISOString(),   // 导入 = 本机此刻改过，合并时按它算新旧
                    createdAt: new Date().toISOString()
                });
                productCount++;
            } else if (type === '映射') {
                const mapping = {
                    id: Date.now() + i + 1000,   // 确保ID与商品不冲突
                    barcode: barcode,
                    productName: productName,
                    updatedAt: new Date().toISOString()
                };
                const existingIndex = productMappings.findIndex(function(m) { return m.barcode === barcode; });
                if (existingIndex >= 0) {
                    productMappings[existingIndex] = mapping;
                } else {
                    productMappings.push(mapping);
                }
                mappingCount++;
            }
        }

        saveProducts();
        saveMappings();
        updateProductList();
        updateMappingList();

        alert('成功导入 ' + productCount + ' 条商品记录和 ' + mappingCount + ' 条映射记录！');
    };

    reader.readAsText(file, 'UTF-8');

    // 重置文件输入
    e.target.value = '';
}

// 清空所有数据
function clearAllData() {
    if (!confirm('确定要清空所有数据吗？此操作不可恢复！')) return;

    products = [];
    productMappings = [];
    // 删除标记（墓碑）一并清掉：清空就是清空。
    // 清掉也不会让删过的记录借别的设备复活 —— 墓碑删除时已经推到云端了，
    // 云端那份还在，别处的旧副本照样会被它删掉
    productTombstones = [];
    mappingTombstones = [];
    saveProducts();
    saveMappings();
    saveTombstones();
    updateProductList();
    updateMappingList();
    alert('所有数据已清空！');
}

/* ===================== 9. 数据概览 ===================== */
// 这里原来是一张 Chart.js 柱状图（正常 / 1-3个月 / 1个月内 / 已过期 四根柱子），改成一行小标签。
// 删掉图表的理由：
//   1. 它占 300~400px（手机上正好一整屏），却只画了 4 个数，其中「已过期 / 30 天内」
//      顶部横幅里写得更清楚（还带商品名和「只看这些」）；
//   2. 它排除了已处理和未填有效期的记录，柱子加起来和列表行数对不上，反而让人犯嘀咕；
//   3. 顺带省掉 205KB 的 chart.umd.js。
// 换成一行标签后同样一眼看完，高度只剩二十几像素，而且数字能和列表对上。
function updateStatsStrip() {
    const strip = document.getElementById('statsStrip');
    if (!strip) return;

    const counts = { normal: 0, warning: 0, danger: 0, expired: 0, unknown: 0 };
    let handled = 0;

    products.forEach(function(product) {
        if (isHandled(product)) {
            handled++;   // 已处理的不算进到期统计，但单独显示一个数
            return;
        }
        counts[getExpiryStatus(product.validity)]++;
    });

    // 数量为 0 的标签不显示 —— 一行里塞满空标签只会更难读
    const chips = [
        ['normal', '正常', counts.normal],
        ['warning', '1-3个月', counts.warning],
        ['danger', '30天内', counts.danger],
        ['expired', '已过期', counts.expired],
        ['unknown', '未填有效期', counts.unknown],
        ['handled', '已处理', handled]
    ].filter(function(item) {
        return item[2] > 0;
    }).map(function(item) {
        return '<span class="stat-chip stat-' + item[0] + '">' + item[1] + ' ' + item[2] + '</span>';
    }).join('');

    strip.innerHTML = '<span class="stat-total">共 ' + products.length + ' 条</span>' + chips;
}

// 加载数据
function loadData() {
    products = JSON.parse(localStorage.getItem('products')) || [];
    productMappings = JSON.parse(localStorage.getItem('productMappings')) || [];
    productTombstones = JSON.parse(localStorage.getItem('productTombstones')) || [];
    mappingTombstones = JSON.parse(localStorage.getItem('mappingTombstones')) || [];

    // 老数据没有 uid，这里补上并立刻落盘（云端的老记录会在同步时认领）
    if (products.some(function(p) { return !p.uid; })) {
        products = ensureProductUids(products, null);
        saveProducts();
    }
}

/* ===================== 9.5 记录唯一标识 ===================== */

// 商品用 uid 做唯一标识。
// 以前拿「条码」当唯一键，同一箱牛奶这周和下月各买一次（条码相同、生产日期不同），
// 同步时后录入的会把前一条覆盖掉，云端和本地一起少一条数据。
function makeUid() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// 老记录的指纹：条码 + 生产日期。用来判断「云端的这条」和「本地的这条」是不是同一样东西
function productFingerprint(product) {
    return String(product.barcode || '') + '\u0001' + String(product.productionDate || '');
}

// 给缺 uid 的记录补 uid；uidIndex 能查到同款记录时优先沿用它的 uid，避免迁移时凭空多出一条
function ensureProductUids(list, uidIndex) {
    return (list || []).map(function(product) {
        if (!product.uid) {
            const fingerprint = productFingerprint(product);
            product.uid = (uidIndex && uidIndex[fingerprint]) || makeUid();
        }
        return product;
    });
}

// 本地记录按指纹建索引：指纹 -> uid
function buildUidIndex(list) {
    const index = {};
    (list || []).forEach(function(product) {
        if (product.uid) index[productFingerprint(product)] = product.uid;
    });
    return index;
}

/* ---- 删除标记（墓碑） ---- */
// 判断一条记录是「活记录」还是「删除标记」
function isTombstone(record) {
    return !!(record && record.deletedAt);
}

// 商品墓碑：留着条码和生产日期，因为云端还挂着没 uid 的老记录时，
// 只能靠「条码 + 生产日期」这个指纹把它认出来（见 mergeProducts）
function makeProductTombstone(product, deletedAt) {
    return {
        uid: product.uid || '',
        barcode: product.barcode || '',
        productName: product.productName || '',
        productionDate: product.productionDate || '',
        deletedAt: deletedAt,
        updatedAt: deletedAt
    };
}

// 映射墓碑：映射按条码唯一，有条码就够了
function makeMappingTombstone(mapping, deletedAt) {
    return {
        barcode: mapping.barcode || '',
        productName: mapping.productName || '',
        deletedAt: deletedAt,
        updatedAt: deletedAt
    };
}

/* ---- 记录的最后修改时间：跨设备同步靠它判断「哪份更新」 ---- */
// 记录被改动时打一次时间戳。新增、编辑、标记处置、撤销处置、改名、导入都要调。
function touchRecord(record) {
    if (record) record.updatedAt = new Date().toISOString();
    return record;
}

// 取记录的最后修改时间（毫秒）。没有 updatedAt 的老记录用 handledAt 兜底：
// 标记过处置的老记录，至少是在那一天之后才变成现在这样的；从没被动过的算 0。
//
// 这条兜底不能省 —— 存量数据全是老格式，少了它老记录之间就没法比新旧，
// 只能退回「一边通吃」，又回到「换设备看不到已处理」那个坑里。
function recordModifiedTime(record) {
    if (!record) return 0;

    const updated = Date.parse(record.updatedAt);
    if (!isNaN(updated)) return updated;

    // 墓碑万一没有 updatedAt，至少要按删除时间算
    const deleted = Date.parse(record.deletedAt);
    if (!isNaN(deleted)) return deleted;

    const handled = Date.parse(record.handledAt);
    return isNaN(handled) ? 0 : handled;
}

// 统计 listB 里有、listA 里没有的记录条数（按 key 比）。只为提示里的「新增/删除」计数
function countOnlyIn(listA, listB, key) {
    const keys = {};
    (listA || []).forEach(function(item) {
        if (item) keys[String(item[key])] = true;
    });
    return (listB || []).filter(function(item) {
        return item && !keys[String(item[key])];
    }).length;
}

// 同一条记录两边都有时，取最后修改时间更晚的那条。
// 只有时间完全相同（或两边都取不到时间）才用 preferLocal 决定：
//   preferLocal = true  → 同步（推送）方向：本机优先
//   preferLocal = false → 获取最新数据（拉取）方向：云端优先
function pickNewerRecord(cloudRecord, localRecord, preferLocal) {
    const cloudTime = recordModifiedTime(cloudRecord);
    const localTime = recordModifiedTime(localRecord);

    if (cloudTime === localTime) return preferLocal ? localRecord : cloudRecord;
    return cloudTime > localTime ? cloudRecord : localRecord;
}

// 按 uid 合并商品，返回 { products, tombstones }：
//   products   —— 活记录，同 uid 的冲突逐条比最后修改时间，谁新用谁
//   tombstones —— 生效的删除标记，两边都留着，下次同步继续压制别的设备手里的旧副本
//
// 云端那份里混着墓碑（带 deletedAt），先拆开。删除与「删完又改」的判定：
//   · 墓碑更新 → 记录被删掉，别的设备手里的旧副本也一并消失
//   · 记录更新 → 这条在别处被改过，以改动为准，墓碑作废（删完还能救回来）
// 加上原有的「谁新谁赢」，推送和拉取两个方向都不会丢数据，
// 先点「同步」还是先点「获取最新数据」都不影响结果。
// preferLocal 只在时间打平时起作用（两边都没动过、内容却不一样）。
function mergeProducts(cloudList, localList, localTombstones, preferLocal) {
    // 云端列表里混着墓碑，先按 deletedAt 拆开
    const cloudLive = [];
    const cloudTombstones = [];
    (cloudList || []).forEach(function(record) {
        if (!record) return;
        (isTombstone(record) ? cloudTombstones : cloudLive).push(record);
    });

    // 必须先给本地记录补齐 uid，再按指纹建索引。
    // 否则本地记录恰好都没 uid 时，云端的老记录匹配不到、会被当成新记录重复插入。
    const localWithUid = ensureProductUids(localList, null);
    const uidIndex = buildUidIndex(localWithUid);
    const cloudWithUid = ensureProductUids(cloudLive, uidIndex);

    // 1. 活记录：云端那份先铺底，输出顺序就稳定，同步前后列表不会莫名重排
    const liveByUid = new Map();
    const cloudByUid = new Map();           // 云端：uid → 记录
    const cloudByFingerprint = new Map();   // 云端：条码 + 生产日期 → 记录
    const cloudByBarcode = new Map();       // 云端：条码 → 记录（有一边缺生产日期时的兜底）

    function pushIndex(index, key, record) {
        const bucket = index.get(key);
        if (bucket) bucket.push(record);
        else index.set(key, [record]);
    }

    cloudWithUid.forEach(function(product) {
        liveByUid.set(String(product.uid), product);
        cloudByUid.set(String(product.uid), product);
        pushIndex(cloudByFingerprint, productFingerprint(product), product);
        pushIndex(cloudByBarcode, String(product.barcode || ''), product);
    });

    // 已经配过对的云端记录，不能再被本机另一条认领
    const claimedUids = new Set();

    // uid 对不上时（同一件东西在两台设备上各自补过一个 uid）退回按内容认领：
    // 先比「条码 + 生产日期」，有一边没记生产日期时再退一步只比条码。
    // 少了这一步，另一台设备点「获取最新数据」会看到整份列表翻倍，
    // 而且本机这条（例如刚标记的「已处理」）和云端那条被算成两件东西
    function claimCloudRecord(product) {
        // 没有条码就没法可靠判断是不是同一条（空指纹会把一堆无关记录串在一起），只按 uid 区分
        if (!product.barcode) return null;

        const byFingerprint = cloudByFingerprint.get(productFingerprint(product)) || [];
        // 两边都写了生产日期时，日期不同就是不同批次，不能算同一条
        const byBarcode = (cloudByBarcode.get(String(product.barcode)) || [])
            .filter(function(record) {
                return !product.productionDate || !record.productionDate;
            });

        const candidates = byFingerprint.concat(byBarcode);
        for (let i = 0; i < candidates.length; i++) {
            const key = String(candidates[i].uid);
            if (!claimedUids.has(key)) {
                claimedUids.add(key);
                return candidates[i];
            }
        }
        return null;
    }

    localWithUid.forEach(function(product) {
        const key = String(product.uid);
        const byUid = cloudByUid.get(key);

        if (byUid) {
            claimedUids.add(key);
            liveByUid.set(key, pickNewerRecord(byUid, product, preferLocal));
            return;
        }

        const claimed = claimCloudRecord(product);
        if (claimed) {
            // 身份沿用云端那条：下次同步两边才认得出是同一条，不会再各留一份
            const winner = pickNewerRecord(claimed, product, preferLocal);
            winner.uid = claimed.uid;
            liveByUid.set(String(claimed.uid), winner);
            return;
        }

        // 只在本机存在、云端没有的记录，原样留下，下次同步会推上去
        liveByUid.set(key, product);
    });

    // 2. 兜底去重：条码 + 生产日期相同的记录只留最近改过的一条。
    // 本机列表如果已经被「uid 不一致」撑成了两份，这一步顺手收敛回一条，不用手工删重复
    const deduped = [];
    const fingerprintIndex = new Map();

    liveByUid.forEach(function(product) {
        // 没有条码就没法可靠判断是不是同一条，只按 uid 区分
        const fingerprint = product.barcode
            ? productFingerprint(product)
            : 'uid\u0001' + String(product.uid);
        const at = fingerprintIndex.get(fingerprint);

        if (at === undefined) {
            fingerprintIndex.set(fingerprint, deduped.length);
            deduped.push(product);
            return;
        }

        const kept = deduped[at];
        const winner = pickNewerRecord(kept, product, preferLocal);

        // 内容可以换成更新的那份，身份要留住云端已经写下的那个 uid，
        // 否则别的设备手里那份又会对不上、重新分裂成两条
        if (String(kept.uid) !== String(product.uid)) {
            if (cloudByUid.has(String(kept.uid))) winner.uid = kept.uid;
            else if (cloudByUid.has(String(product.uid))) winner.uid = product.uid;
        }

        deduped[at] = winner;
    });

    // 3. 墓碑：同一件东西两边可能各留过一条（删了又删），取时间最新的那条
    const tombByKey = new Map();

    function rememberTombstone(tombstone) {
        if (!tombstone || !tombstone.barcode) return;

        const key = tombstone.uid ? 'u' + tombstone.uid : 'f' + productFingerprint(tombstone);
        const existing = tombByKey.get(key);
        if (!existing || recordModifiedTime(tombstone) > recordModifiedTime(existing)) {
            tombByKey.set(key, tombstone);
        }
    }

    cloudTombstones.forEach(rememberTombstone);
    (localTombstones || []).forEach(rememberTombstone);

    // 4. 墓碑与活记录对账
    const finalByUid = new Map();
    const liveByFingerprint = new Map();
    deduped.forEach(function(product) {
        finalByUid.set(String(product.uid), product);
        liveByFingerprint.set(productFingerprint(product), product);
    });

    const deletedUids = new Set();
    const tombstones = [];

    tombByKey.forEach(function(tombstone) {
        // 优先按 uid 找；云端还挂着没 uid 的老记录时，靠「条码 + 生产日期」认领
        let target = tombstone.uid ? finalByUid.get(String(tombstone.uid)) : null;
        if (!target) target = liveByFingerprint.get(productFingerprint(tombstone));

        if (target && recordModifiedTime(target) > recordModifiedTime(tombstone)) {
            return;   // 删掉之后又在别处改过 → 以改动为准，墓碑作废
        }
        if (target) deletedUids.add(String(target.uid));
        tombstones.push(tombstone);
    });

    return {
        products: deduped.filter(function(product) {
            return !deletedUids.has(String(product.uid));
        }),
        tombstones: tombstones
    };
}

// 映射按条码合并：一个条码本来就只该对应一个名称，这里特意不用 uid。
// 冲突判定与 mergeProducts 一致（先比修改时间，打平才看 preferLocal），同样返回墓碑
function mergeMappings(cloudList, localList, localTombstones, preferLocal) {
    const cloudLive = [];
    const cloudTombstones = [];

    (cloudList || []).forEach(function(record) {
        if (!record || !record.barcode) return;
        (isTombstone(record) ? cloudTombstones : cloudLive).push(record);
    });

    const liveByBarcode = new Map();
    cloudLive.forEach(function(mapping) {
        liveByBarcode.set(String(mapping.barcode), mapping);
    });

    (localList || []).forEach(function(mapping) {
        if (!mapping || !mapping.barcode) return;

        const key = String(mapping.barcode);
        const cloudRecord = liveByBarcode.get(key);
        liveByBarcode.set(key, cloudRecord ? pickNewerRecord(cloudRecord, mapping, preferLocal) : mapping);
    });

    const tombByBarcode = new Map();

    function rememberTombstone(tombstone) {
        if (!tombstone || !tombstone.barcode) return;

        const key = String(tombstone.barcode);
        const existing = tombByBarcode.get(key);
        if (!existing || recordModifiedTime(tombstone) > recordModifiedTime(existing)) {
            tombByBarcode.set(key, tombstone);
        }
    }

    cloudTombstones.forEach(rememberTombstone);
    (localTombstones || []).forEach(rememberTombstone);

    const deletedBarcodes = new Set();
    const tombstones = [];

    tombByBarcode.forEach(function(tombstone) {
        const target = liveByBarcode.get(String(tombstone.barcode));
        if (target && recordModifiedTime(target) > recordModifiedTime(tombstone)) {
            return;   // 删掉之后又改过 → 以改动为准，墓碑作废
        }
        if (target) deletedBarcodes.add(String(target.barcode));
        tombstones.push(tombstone);
    });

    return {
        mappings: Array.from(liveByBarcode.values()).filter(function(mapping) {
            return !deletedBarcodes.has(String(mapping.barcode));
        }),
        tombstones: tombstones
    };
}

/* ---- 云端文档 → 本地记录 ---- */
// 字段清单必须和 upsertCollection 的白名单一致，
// 漏一个就会出现「同步后处置状态 / 修改时间丢了」
function cloudDocToProduct(doc) {
    return {
        id: doc.uid || doc._id,      // 兼容旧字段
        uid: doc.uid || '',          // 空 uid 会在合并时补上，下次同步回填云端
        barcode: doc.barcode,
        productName: doc.productName,
        type: doc.type || '商品',
        scanDate: doc.scanDate || '',
        productionDate: doc.productionDate || '',
        shelfLife: doc.shelfLife || '',
        shelfLifeUnit: doc.shelfLifeUnit || '月',
        validity: doc.validity || '',
        handledAction: doc.handledAction || '',
        handledAt: doc.handledAt || '',
        handledNote: doc.handledNote || '',
        updatedAt: doc.updatedAt || '',   // 缺了它就只能退回 handledAt 兜底
        deletedAt: doc.deletedAt || '',   // 有值 = 这条是删除标记（墓碑），不是活记录
        createdAt: doc._createTime
            ? new Date(doc._createTime).toISOString()
            : new Date().toISOString()
    };
}

function cloudDocToMapping(doc) {
    return {
        id: doc._id,
        barcode: doc.barcode,
        productName: doc.productName,
        updatedAt: doc.updatedAt || '',
        deletedAt: doc.deletedAt || ''   // 有值 = 删除标记（墓碑）
    };
}

/* ===================== 10. 云端同步 ===================== */

// GitHub 存储：与云端对账后写回，并让本机收敛到合并结果。
// 「同步数据」按钮和「删除后静默推送」共用这一段。
async function saveMergedToGithub(cloud, message) {
    const mergedProducts = mergeProducts(cloud.products, products, productTombstones, true);
    const mergedMappings = mergeMappings(cloud.mappings, productMappings, mappingTombstones, true);

    // 墓碑以「带 deletedAt 的记录」的形式和活记录一起写进 data.json：
    // 不另开一段存储，别的设备一读就知道这条是被删掉的
    await ghSave(
        mergedProducts.products.concat(mergedProducts.tombstones),
        mergedMappings.mappings.concat(mergedMappings.tombstones),
        message
    );

    products = mergedProducts.products;
    productTombstones = mergedProducts.tombstones;
    productMappings = mergedMappings.mappings;
    mappingTombstones = mergedMappings.tombstones;

    saveProducts();
    saveMappings();
    saveTombstones();
    updateProductList();
    updateMappingList();
    updateReminder();

    return { productCount: products.length, mappingCount: productMappings.length };
}

// 删除后立刻把墓碑推上云端，不用等用户再点一次「同步」。
// 推不上去也不回滚：本机已经删掉了，下次点「同步」会把墓碑补上去
async function pushTombstonesQuietly() {
    try {
        if (IS_GITHUB_PAGES) {
            if (!ghToken) return;   // 还没填令牌，等点「同步」时一起走
            const cloud = await ghLoad();
            await saveMergedToGithub(cloud, '删除记录');
            return;
        }

        if (!cloudReady) return;   // 云端没连上，等点「同步」时一起走

        // 墓碑就是「带 deletedAt 的文档」，按 uid / 条码 upsert 到同一个集合里
        await upsertCollection(PRODUCT_COLLECTION, productTombstones, null);
        await upsertCollection(MAPPING_COLLECTION, mappingTombstones, null);
    } catch (error) {
        console.error('删除标记推送云端失败:', error);
        showToast('已在本机删除；推送云端失败，下次点「同步」会补上', '#ff9800', 5000);
    }
}

// 同步本地数据到云端（按 uid 匹配：有则更新，无则新增）
async function syncData() {
    /* ---- GitHub 存储：本地与云端合并后写回 ---- */
    if (IS_GITHUB_PAGES) {
        if (!await ensureGhToken()) return;

        // 只剩墓碑也要同步：本机删空之后，「删除」这件事本身得推到云端
        const localCount = products.length + productMappings.length +
                           productTombstones.length + mappingTombstones.length;
        if (localCount === 0) {
            alert('没有数据需要同步！');
            return;
        }

        showToast('正在同步数据到 GitHub ...', '#4CAF50', 60000);

        try {
            const cloud = await ghLoad();

            // 商品按 uid 合并（同一条码的不同批次不再互相覆盖），映射按条码合并。
            // 逐条比最后修改时间：本机改得更晚的推上去，云端更新的留在云端，
            // 墓碑同样参与比时间，删掉的东西不会被别的设备带回来
            const result = await saveMergedToGithub(cloud, '同步商品数据');

            showToast('同步完成：商品 ' + result.productCount + ' 条', '#45a049', 5000);
            alert('数据同步完成！\n商品: ' + result.productCount + ' 条\n映射: ' + result.mappingCount + ' 条');
        } catch (error) {
            console.error('GitHub 同步失败:', error);
            showToast('同步失败：' + (error.message || '未知错误'), '#f44336', 5000);
            alert('数据同步失败：' + (error.message || '未知错误'));
        }
        return;
    }

    if (!await ensureCloud()) return;

    const totalItems = products.length + productMappings.length +
                       productTombstones.length + mappingTombstones.length;
    if (totalItems === 0) {
        alert('没有数据需要同步！');
        return;
    }

    showToast('正在同步数据到云端...', '#4CAF50', 60000);

    try {
        // 先把云端快照拉下来，逐条比最后修改时间再决定写什么：
        //   · 本机是旧副本时，云端更新的记录（例如别的设备刚标记的处置）不会被覆盖掉
        //   · 本机改得更晚的记录照常推上去，删除标记也一样
        // 于是「先同步还是先获取」都不会丢数据，按钮顺序不再是坑
        const cloudProductDocs = await fetchAllFromCloud(PRODUCT_COLLECTION);
        const cloudMappingDocs = await fetchAllFromCloud(MAPPING_COLLECTION);

        const mergedProducts = mergeProducts(
            cloudProductDocs.map(cloudDocToProduct), products, productTombstones, true);
        const mergedMappings = mergeMappings(
            cloudMappingDocs.map(cloudDocToMapping), productMappings, mappingTombstones, true);

        // 墓碑跟着活记录一起写回同一个集合（就是带 deletedAt 的文档），
        // 不用新建集合，也就不用再去 CloudBase 控制台开一次权限
        const productResult = await upsertCollection(
            PRODUCT_COLLECTION,
            mergedProducts.products.concat(mergedProducts.tombstones),
            cloudProductDocs);
        const mappingResult = await upsertCollection(
            MAPPING_COLLECTION,
            mergedMappings.mappings.concat(mergedMappings.tombstones),
            cloudMappingDocs);

        // 本机也收敛到合并结果：否则界面还显示旧状态，看着像同步没生效
        products = mergedProducts.products;
        productTombstones = mergedProducts.tombstones;
        productMappings = mergedMappings.mappings;
        mappingTombstones = mergedMappings.tombstones;
        saveProducts();
        saveMappings();
        saveTombstones();
        updateProductList();
        updateMappingList();
        updateReminder();

        const successCount = productResult.success + mappingResult.success;
        const failCount = productResult.fail + mappingResult.fail;

        showToast(
            '数据同步完成：成功 ' + successCount + ' 项，失败 ' + failCount + ' 项',
            failCount === 0 ? '#45a049' : '#ff9800',
            5000
        );
        alert('数据同步完成！\n商品: ' + products.length + ' 条\n映射: ' + productMappings.length + ' 条\n' +
              '写入成功: ' + successCount + ' 项' + (failCount > 0 ? '\n失败: ' + failCount + ' 项' : ''));
    } catch (error) {
        console.error('数据同步失败:', error);
        showToast('同步失败：' + (error.message || '未知错误'), '#f44336', 5000);
        alert('数据同步失败：' + (error.message || '未知错误'));
    }
}

// 把本地数组写入云端集合。
// 商品按 uid 匹配；映射按条码匹配（一个条码本来就只该有一条映射）
async function upsertCollection(collectionName, localItems, cloudSnapshot) {
    const isProduct = collectionName === PRODUCT_COLLECTION;
    // 字段清单必须和 cloudDocToProduct / cloudDocToMapping 保持一致，
    // 漏一个就会出现「同步后处置状态 / 修改时间丢了」
    const fields = isProduct
        ? ['uid', 'barcode', 'productName', 'type', 'scanDate', 'productionDate', 'shelfLife', 'shelfLifeUnit', 'validity',
           'handledAction', 'handledAt', 'handledNote', 'updatedAt', 'deletedAt']
        : ['barcode', 'productName', 'updatedAt', 'deletedAt'];

    // 1. 云端已有记录，建立「匹配键 -> _id」映射。
    //    cloudSnapshot 是调用方刚拉过的快照，传了就直接用，不再多读一遍
    const cloudItems = cloudSnapshot || await fetchAllFromCloud(collectionName);
    const idByKey = {};
    const legacyIdByBarcode = {};   // 迁移用：还没有 uid 的历史记录

    cloudItems.forEach(function(doc) {
        if (isProduct) {
            if (doc.uid) idByKey[doc.uid] = doc._id;
            else if (doc.barcode) legacyIdByBarcode[doc.barcode] = doc._id;
        } else if (doc.barcode) {
            idByKey[doc.barcode] = doc._id;
        }
    });

    // 历史记录只能被认领一次，否则同条码的第二条又会覆盖到同一条上
    function takeLegacyId(barcode) {
        const id = legacyIdByBarcode[barcode];
        if (id) delete legacyIdByBarcode[barcode];
        return id;
    }

    // 2. 区分「需新增」和「需更新」
    const toAdd = [];
    const toUpdate = [];

    localItems.forEach(function(item) {
        if (item.barcode === undefined || item.barcode === null || item.barcode === '') return;

        if (isProduct && !item.uid) item.uid = makeUid();

        const data = {};
        fields.forEach(function(field) {
            data[field] = item[field] === undefined || item[field] === null ? '' : item[field];
        });

        const existedId = isProduct
            ? (idByKey[item.uid] || takeLegacyId(item.barcode))
            : idByKey[item.barcode];

        if (existedId) {
            toUpdate.push({ id: existedId, data: data });
        } else {
            toAdd.push(data);
        }
    });

    let success = 0;
    let fail = 0;

    // 3. 批量新增（SDK 支持数组一次性写入）
    if (toAdd.length > 0) {
        try {
            await cbDb.collection(collectionName).add(toAdd);
            success += toAdd.length;
        } catch (error) {
            console.error('批量新增失败，改为逐条写入:', error);
            for (let i = 0; i < toAdd.length; i++) {
                try {
                    await cbDb.collection(collectionName).add(toAdd[i]);
                    success++;
                } catch (e) {
                    fail++;
                    console.error('新增失败:', e);
                }
            }
        }
    }

    // 4. 逐条更新（每批 20 条并发）
    const CHUNK = 20;
    for (let i = 0; i < toUpdate.length; i += CHUNK) {
        const chunk = toUpdate.slice(i, i + CHUNK);
        const results = await Promise.all(chunk.map(function(updateItem) {
            return cbDb.collection(collectionName)
                .doc(updateItem.id)
                .update(updateItem.data)
                .then(function() { return true; })
                .catch(function(e) {
                    console.error('更新失败:', e);
                    return false;
                });
        }));
        results.forEach(function(ok) { ok ? success++ : fail++; });
    }

    return { success: success, fail: fail };
}

// 从云端获取最新数据（与本地合并，谁新用谁）
async function fetchLatestDataFromCloud() {
    /* ---- GitHub 存储 ---- */
    if (IS_GITHUB_PAGES) {
        if (!await ensureGhToken()) return;

        showToast('正在从 GitHub 获取最新数据 ...', '#2196F3', 60000);

        try {
            const cloud = await ghLoad();

            // 逐条比最后修改时间，谁新用谁：云端更新过的拉过来，本机刚改过的留着。
            // 云端那份里的墓碑（别的设备删掉的）同样算数：
            // 本机手里那条旧副本会在这里被删掉，而不是把云端已经删掉的记录又带回来
            const mergedProducts = mergeProducts(cloud.products, products, productTombstones, false);
            const mergedMappings = mergeMappings(cloud.mappings, productMappings, mappingTombstones, false);
            const addedProducts = countOnlyIn(products, mergedProducts.products, 'uid');
            const removedProducts = countOnlyIn(mergedProducts.products, products, 'uid');
            const addedMappings = countOnlyIn(productMappings, mergedMappings.mappings, 'barcode');
            const removedMappings = countOnlyIn(mergedMappings.mappings, productMappings, 'barcode');

            products = mergedProducts.products;
            productTombstones = mergedProducts.tombstones;
            productMappings = mergedMappings.mappings;
            mappingTombstones = mergedMappings.tombstones;
            saveProducts();
            saveMappings();
            saveTombstones();
            updateProductList();
            updateMappingList();
            updateReminder();

            // 本机较新的改动（例如刚标记的「已处理」）一并写回云端：
            // 只拉不推的话，本机改过的东西别的设备永远看不到
            try {
                await ghSave(
                    mergedProducts.products.concat(mergedProducts.tombstones),
                    mergedMappings.mappings.concat(mergedMappings.tombstones),
                    '获取最新数据'
                );
            } catch (writeError) {
                console.error('回写云端失败:', writeError);
                showToast('本地已合并，但回写云端失败：' + (writeError.message || '未知错误'), '#ff9800', 5000);
            }

            showToast('获取完成：商品 ' + products.length + ' 条', '#45a049', 5000);
            alert('已与云端数据合并（两边谁更新用谁）！\n' +
                  '商品: ' + products.length + ' 条（新增 ' + addedProducts + '，删除 ' + removedProducts + '）\n' +
                  '映射: ' + productMappings.length + ' 条（新增 ' + addedMappings + '，删除 ' + removedMappings + '）');
        } catch (error) {
            console.error('GitHub 获取数据失败:', error);
            showToast('获取失败：' + (error.message || '未知错误'), '#f44336', 5000);
            alert('数据获取失败：' + (error.message || '未知错误'));
        }
        return;
    }

    if (!await ensureCloud()) return;

    showToast('正在从云端获取最新数据...', '#2196F3', 60000);

    try {
        const cloudProductDocs = await fetchAllFromCloud(PRODUCT_COLLECTION);
        const cloudMappingDocs = await fetchAllFromCloud(MAPPING_COLLECTION);

        // 逐条比最后修改时间，谁新用谁：云端更新过的拉过来，本机刚改过的留着。
        // 云端那份里的墓碑（别的设备删掉的）同样算数，本机的旧副本会被它删掉
        const mergedProducts = mergeProducts(
            cloudProductDocs.map(cloudDocToProduct), products, productTombstones, false);
        const addedProducts = countOnlyIn(products, mergedProducts.products, 'uid');
        const removedProducts = countOnlyIn(mergedProducts.products, products, 'uid');

        products = mergedProducts.products;
        productTombstones = mergedProducts.tombstones;
        saveProducts();
        saveTombstones();
        updateProductList();
        updateReminder();

        const mergedMappings = mergeMappings(
            cloudMappingDocs.map(cloudDocToMapping), productMappings, mappingTombstones, false);
        const addedMappings = countOnlyIn(productMappings, mergedMappings.mappings, 'barcode');
        const removedMappings = countOnlyIn(mergedMappings.mappings, productMappings, 'barcode');

        productMappings = mergedMappings.mappings;
        mappingTombstones = mergedMappings.tombstones;
        saveMappings();
        saveTombstones();
        updateMappingList();

        // 本机较新的改动一并写回云端（同 GitHub 分支的说明）：
        // 只拉不推的话，本机改过的东西别的设备永远看不到
        try {
            await upsertCollection(
                PRODUCT_COLLECTION, products.concat(productTombstones), cloudProductDocs);
            await upsertCollection(
                MAPPING_COLLECTION, productMappings.concat(mappingTombstones), cloudMappingDocs);
        } catch (writeError) {
            console.error('回写云端失败:', writeError);
        }

        showToast(
            '数据获取完成：商品 ' + products.length + ' 条，映射 ' + productMappings.length + ' 条',
            '#45a049',
            5000
        );
        alert('已与云端数据合并（两边谁更新用谁）！\n' +
              '商品: ' + products.length + ' 条（新增 ' + addedProducts + '，删除 ' + removedProducts + '）\n' +
              '映射: ' + productMappings.length + ' 条（新增 ' + addedMappings + '，删除 ' + removedMappings + '）');
    } catch (error) {
        console.error('获取云端数据失败:', error);
        showToast('获取失败：' + (error.message || '未知错误'), '#f44336', 5000);
        alert('数据获取失败：' + (error.message || '未知错误'));
    }
}

/* ===================== 11. 实时数据监听 ===================== */
function startRealtimeWatch() {
    if (!cloudReady) {
        console.log('云端未就绪，跳过实时数据监听');
        return;
    }

    closeCloudWatchers();

    try {
        // 监听商品集合
        const productWatcher = cbDb.collection(PRODUCT_COLLECTION).watch({
            onChange: function(snapshot) {
                if (!snapshot || snapshot.type === 'init') return;
                (snapshot.docChanges || []).forEach(function(change) {
                    const doc = change.doc || {};
                    const label = doc.productName || doc.barcode || '';
                    if (change.dataType === 'add') {
                        showToast('新商品添加：' + label, '#2196F3');
                    } else if (change.dataType === 'update') {
                        showToast('商品更新：' + label, '#2196F3');
                    } else if (change.dataType === 'remove') {
                        showToast('云端有商品被删除', '#ff9800');
                    }
                });
            },
            onError: function(error) {
                console.error('商品实时监听错误:', error);
            }
        });
        cloudWatchers.push(productWatcher);

        // 监听映射集合
        const mappingWatcher = cbDb.collection(MAPPING_COLLECTION).watch({
            onChange: function(snapshot) {
                if (!snapshot || snapshot.type === 'init') return;
                (snapshot.docChanges || []).forEach(function(change) {
                    const doc = change.doc || {};
                    if (change.dataType === 'add') {
                        showToast('新映射添加：' + (doc.barcode || ''), '#2196F3');
                    } else if (change.dataType === 'update') {
                        showToast('映射更新：' + (doc.barcode || ''), '#2196F3');
                    } else if (change.dataType === 'remove') {
                        showToast('云端有映射被删除', '#ff9800');
                    }
                });
            },
            onError: function(error) {
                console.error('映射实时监听错误:', error);
            }
        });
        cloudWatchers.push(mappingWatcher);

        console.log('实时数据监听已启动');
    } catch (error) {
        console.error('初始化实时数据监听失败:', error);
    }
}

// 关闭全部实时监听
function closeCloudWatchers() {
    cloudWatchers.forEach(function(watcher) {
        try {
            watcher.close();
        } catch (e) {
            // 忽略关闭异常
        }
    });
    cloudWatchers = [];
}
