/* ============================================================
 * 商品到期提醒系统 —— 前端
 *
 * 数据怎么走：
 *   页面 --(访问口令)--> 云函数 product-api --(GitHub 令牌)--> 仓库 data.json
 * 浏览器里不再保存任何仓库令牌，也不直连数据库：令牌只存在云端环境变量，
 * 页面只跟自己的接口说话，且要带上访问口令。
 *
 * 合并规则 / 日期 / CSV 都在 shared/ 里，云函数与页面共用同一份代码
 * （index.html 先加载 shared/*.js，再加载本文件；云函数由部署脚本复制到 lib/）。
 * 本文件只负责：界面、本机缓存（localStorage）、调用接口。
 * ============================================================ */

/* 把共享模块挂到全局。
   原来是「顶层函数即全局函数」，页面上有内联 onclick，所以这里不能用
   const 解构（那样不会成为 window 属性，内联事件会找不到函数）。 */
(function exposeSharedModules() {
    const shared = window.ExpiryShared || {};
    ['dates', 'merge', 'csv'].forEach(function(name) {
        const mod = shared[name];
        if (!mod) {
            console.error('共享模块未加载：shared/' + name + '.js');
            return;
        }
        Object.keys(mod).forEach(function(key) {
            window[key] = mod[key];
        });
    });
})();

/* ===================== 0. 接口配置 ===================== */
// 数据接口地址：CloudBase「HTTP 访问服务」里绑到云函数 product-api 的路径
const API_BASE = 'https://trae-projects-4g5aob6ufac38569-1421597865.ap-shanghai.app.tcloudbase.com/api';
const API_KEY_STORE = 'apiKey';

/* 本地预览模式
 * 用 file:// 直接双击打开、或 localhost / 127.0.0.1 访问时自动进入：
 *   · 数据只读写本机 localStorage，一次网络请求都不发（不会污染线上 data.json）
 *   · 数据初值来自 preview-data.js 的云端快照
 * 部署到线上（https 域名）后这个开关自动失效，不需要改任何代码。
 * 另：file:// 与线上 https 是不同的源，localStorage 本来就互不相通，测试数据关在本地。 */
const PREVIEW_MODE = (function () {
    try {
        const h = location.hostname;
        return location.protocol === 'file:' || h === 'localhost' || h === '127.0.0.1';
    } catch (e) {
        return false;
    }
})();

let apiKey = localStorage.getItem(API_KEY_STORE) || '';   // 访问口令（只存在本机）
// 临期窗口天数：由接口下发（product-api 的 REMIND_DAYS），
// 这样「页面判紧急」和「服务端推送」用的是同一个阈值，不会两边各写一个 30
let remindDays = 30;

// 数据只有一份：product-expiry 仓库里的 data.json，由云函数读写。
// 以前这里有一套「GitHub 仓库 / CloudBase 数据库」双模式切换，已经删掉：
//   · 两套数据谁也不认识谁，「换个网址打开看到旧数据」的困惑全来自这里
//   · 云数据库还得把集合权限开成「所有用户可读写」，等于把数据交出去
// 现在页面不管部署在 GitHub Pages 还是腾讯云，读写的都是同一份数据。
//
// 顺带说明：老版本用过的 localStorage 键（ghToken / storageMode）不再使用，
// 但也不主动去删 —— 万一你哪天想回滚旧版本，令牌还在。

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

// 预览模式首次进入：把快照灌进本机。只灌一次，之后测试中的增删都留在本机，
// 想恢复成快照原样，清掉 localStorage 里这 4 个键再刷新即可（见 previewReset）。
if (PREVIEW_MODE && window.PREVIEW_DATA && !localStorage.getItem('previewSeeded')) {
    products = (window.PREVIEW_DATA.products || []).slice();
    productMappings = (window.PREVIEW_DATA.mappings || []).slice();
    productTombstones = [];
    mappingTombstones = [];
    localStorage.setItem('products', JSON.stringify(products));
    localStorage.setItem('productMappings', JSON.stringify(productMappings));
    localStorage.setItem('productTombstones', '[]');
    localStorage.setItem('mappingTombstones', '[]');
    localStorage.setItem('previewSeeded', '1');
}

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

/* ============ 3. 数据接口（云函数 product-api） ============
 * 页面不直连仓库、也不直连数据库，所有数据操作都交给云函数，它做三件事：
 *   校验访问口令 → 与云端合并 → 读写 data.json
 * 好处：仓库令牌不出现在浏览器里；写入前由服务端先合并，两台设备同时改也不会互相覆盖。
 * ==================================================================== */

// 首次使用：让用户填一次访问口令（存在本机，以后不用再填）
async function ensureApiKey() {
    if (PREVIEW_MODE) return true;   // 预览模式不联网，不需要口令
    if (apiKey) return true;

    const input = window.prompt(
        '首次使用需要填写一次「访问口令」。\n\n' +
        '口令是部署时设定的（云函数环境变量 API_KEY，也写在项目的 .env.local 里）。\n' +
        '填过一次就记在本机，换手机或换浏览器时需要再填一次。'
    );

    if (!input || !input.trim()) {
        showToast('未填写访问口令，暂时无法同步数据', '#ff9800');
        return false;
    }

    apiKey = input.trim();
    localStorage.setItem(API_KEY_STORE, apiKey);

    // 立刻验一次：口令错了当场就知道，不用等到同步一半才报错
    try {
        await apiRequest('hello');
        showToast('访问口令已保存到本机', '#4CAF50');
        return true;
    } catch (error) {
        apiKey = '';
        localStorage.removeItem(API_KEY_STORE);
        showToast('口令校验失败：' + (error.message || '未知错误'), '#f44336', 5000);
        return false;
    }
}

// 调一次接口。action: hello（只校验口令）/ pull（合并后返回）/ push（合并 → 写回 → 返回）
// 每次都把本机整份数据带上：由服务端合并，所以先点哪个按钮都不会丢数据
async function apiRequest(action, extra) {
    if (PREVIEW_MODE) return previewApiRequest(action, extra);

    const body = Object.assign({
        action: action,
        key: apiKey,
        products: products,
        mappings: productMappings,
        tombstones: {
            products: productTombstones,
            mappings: mappingTombstones
        }
    }, extra || {});

    let res;
    try {
        res = await fetch(API_BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',   // 同步必须拿最新的，不能被 HTTP 缓存糊住
            body: JSON.stringify(body)
        });
    } catch (error) {
        throw new Error('连不上数据接口，请检查网络或稍后再试');
    }

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 网关出错时返回的可能是 HTML */ }

    if (!json) throw new Error('接口返回异常（HTTP ' + res.status + '）');

    if (res.status === 401) {
        apiKey = '';
        localStorage.removeItem(API_KEY_STORE);
        throw new Error(json.message || '访问口令不正确，请重新输入');
    }
    if (!res.ok || json.code !== 0) {
        throw new Error(json.message || ('操作失败（HTTP ' + res.status + '）'));
    }

    applyRemoteConfig(json.data && json.data.config);
    return json;
}

// 预览模式的假接口：把「本机」当云端，保证一次请求都不发。
// 返回结构照着真接口来，调用方不用为预览改一行。
function previewApiRequest(action) {
    return Promise.resolve({
        code: 0,
        data: {
            products: products.slice(),
            mappings: productMappings.slice(),
            tombstones: {
                products: productTombstones.slice(),
                mappings: mappingTombstones.slice()
            }
        },
        stats: {
            products: products.length,
            remoteLive: products.length,
            mappings: productMappings.length,
            deletedProducts: productTombstones.length,
            remoteTombstones: productTombstones.length
        }
    });
}

// 云端下发的配置：临期窗口只在这一处定义，页面与服务端推送用的是同一个值
function applyRemoteConfig(config) {
    if (!config) return;

    const days = Number(config.remindDays);
    if (!(days > 0) || days === remindDays) return;

    remindDays = days;
    // 阈值变了，列表的状态列和提醒横幅要跟着重算
    updateProductList();
    updateReminder();
}



/* ===================== 4. 页面初始化 ===================== */
document.addEventListener('DOMContentLoaded', function() {
    initializeApp();
});

function initializeApp() {
    // 绑定事件监听器
    bindEventListeners();

    // 包装下拉的选项在 JS 里统一生成：词表只维护一份（PACKAGE_OPTIONS），
    // 写死在 HTML 里迟早会和自检表的分组对不上
    const pkgSelect = document.getElementById('productPackage');
    if (pkgSelect) pkgSelect.innerHTML = packageOptionsHtml('');

    const newPkgSelect = document.getElementById('newPackage');
    if (newPkgSelect) newPkgSelect.innerHTML = packageOptionsHtml('', '包装方式：未填');

    // 本地预览：底部挂一条醒目标记，避免把测试数据当成线上的
    if (PREVIEW_MODE) setupPreviewBanner();

    // 注册 PWA Service Worker：让页面可安装、断网也能打开
    registerServiceWorker();

    // 加载本机缓存
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

    // 顺手问一次接口，把临期窗口天数取回来（已填过口令才问，没填过不打扰）
    // 取不到也不影响使用：先用默认的 30 天显示，下次同步成功会再对齐一次
    refreshConfigQuietly();
}

// 预览模式：底部挂一条提示，说清「数据不上传」，可手动关掉
function setupPreviewBanner() {
    if (document.querySelector('.preview-banner')) return;

    const bar = document.createElement('div');
    bar.className = 'preview-banner';
    bar.innerHTML = '<span><strong>本地预览</strong> · 数据只存这台电脑，不上传；线上数据未受影响</span>' +
                    '<button type="button" class="preview-banner-close" aria-label="关闭">×</button>';

    bar.querySelector('.preview-banner-close').addEventListener('click', function() {
        bar.remove();
        document.body.classList.remove('has-preview-banner');
    });

    document.body.appendChild(bar);
    document.body.classList.add('has-preview-banner');
}

// 静默取一次云端配置（临期窗口天数）。失败不提示 —— 打开页面不该先弹个报错
async function refreshConfigQuietly() {
    if (!apiKey) return;

    try {
        await apiRequest('hello');
    } catch (error) {
        console.warn('获取云端配置失败（不影响本地使用）:', error.message || error);
    }
}

function bindEventListeners() {
    // 商品表单提交
    document.getElementById('productForm').addEventListener('submit', handleProductSubmit);

    // 条码输入变化
    document.getElementById('barcode').addEventListener('input', handleBarcodeChange);

    /* ---------- 录入辅助：名称候选 / 最近商品 ---------- */
    const nameInput = document.getElementById('productName');
    const nameSuggest = document.getElementById('nameSuggest');

    if (nameInput) {
        // 输入即出候选。不走防抖：只是过滤几十条档案，比重建整张表轻得多
        nameInput.addEventListener('input', renderNameSuggest);
        nameInput.addEventListener('focus', renderNameSuggest);
        // 键盘：↓ 进候选、Esc 关掉，方便不打字也能选
        nameInput.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') { hideNameSuggest(); return; }
            if (e.key === 'ArrowDown' && nameSuggest && !nameSuggest.hidden) {
                const first = nameSuggest.querySelector('.suggest-item');
                if (first) { e.preventDefault(); pickNameSuggest(first); }
            }
        });
    }

    if (nameSuggest) {
        // 用 mousedown 而不是 click：click 会先触发 input 的 blur，候选已经收起来了
        nameSuggest.addEventListener('mousedown', function(e) {
            const item = e.target.closest ? e.target.closest('.suggest-item') : null;
            if (!item) return;
            e.preventDefault();
            pickNameSuggest(item);
        });
    }

    const recentChips = document.getElementById('recentChips');
    if (recentChips) {
        recentChips.addEventListener('click', function(e) {
            const chip = e.target.closest ? e.target.closest('.recent-chip') : null;
            if (chip) pickRecent(chip);
        });
    }

    // 点到表单以外就收起候选
    document.addEventListener('click', function(e) {
        if (!e.target.closest || !e.target.closest('.name-input-wrapper')) hideNameSuggest();

        // 搜索框下方的「加一批」同理：点别处就收起，否则纯想搜一下的时候它一直占着屏幕。
        // 但面板已经展开（人正在填日期）时不收 —— 误触一下就把填好的日期弄丢了。
        if (assistState) return;
        if (!e.target.closest) return;
        if (e.target.closest('#listAssist') || e.target.closest('.search-controls')) return;
        hideListAssist();
    });

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

    /* ---------- 搜索框兼做「加一批」入口 ---------- */
    const productSearchInput = document.getElementById('productSearch');
    if (productSearchInput) {
        // 不走防抖：只是过滤几十条档案，比重建整张表轻，跟手更重要
        productSearchInput.addEventListener('input', renderListAssist);
    }
    const productClearBtn = document.getElementById('productClearSearchBtn');
    if (productClearBtn) {
        // 清空动作 bindLiveSearch 已经做了，这里只负责把助手收起来
        productClearBtn.addEventListener('click', hideListAssist);
    }

    const listAssist = document.getElementById('listAssist');
    if (listAssist) {
        listAssist.addEventListener('click', function(e) {
            const t = e.target;

            const item = t.closest ? t.closest('.assist-item') : null;
            if (item) {
                openBatchPanel('existing', item.getAttribute('data-barcode'), item.getAttribute('data-name'));
                return;
            }

            const newBtn = t.closest ? t.closest('.assist-new-btn') : null;
            if (newBtn) {
                openBatchPanel('new', '', newBtn.getAttribute('data-name'));
                return;
            }

            if (t.id === 'batchSaveBtn') { saveBatchRecord(); return; }

            if (t.id === 'batchBackBtn') {
                const q = productSearchInput ? productSearchInput.value.trim() : '';
                assistState = null;
                renderAssistCandidates(q);
                return;
            }

            if (t.id === 'batchRenameBtn') {
                const nameInput = document.getElementById('batchNameInput');
                if (!nameInput) return;
                if (nameInput.readOnly) {
                    nameInput.readOnly = false;
                    nameInput.focus();
                    nameInput.select();
                    t.textContent = '改名中…';
                    showToast('改完点「记一条」保存；改的是这个条码下的所有记录', '#ff9800', 4500);
                } else {
                    nameInput.readOnly = true;
                    t.textContent = '改名';
                }
            }
        });

        // 日期联动：生产日期 / 保质期一改就自动算有效期
        listAssist.addEventListener('input', function(e) {
            if (e.target.id === 'batchProductionDate' || e.target.id === 'batchShelfLife') {
                syncBatchValidity();
            }
        });
        listAssist.addEventListener('change', function(e) {
            if (e.target.id === 'batchShelfLifeUnit') syncBatchValidity();
        });
    }

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

    // 展开时才渲染「最近」：既省得页面一进来就画，也保证列的是最新录入的
    if (open) renderRecentStrip();

    if (!open || !focusBarcode) return;

    const barcodeInput = document.getElementById('barcode');
    if (barcodeInput) barcodeInput.focus();

    // 收起状态下标题栏就在列表下面，一般不用滚；block: 'nearest' 保证
    // 已经在屏幕里时不会有任何跳动，真的在屏幕外才滚
    section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ===================== 4.5 录入辅助 =====================
 * 目标：录入时「有码就扫，没码就打字」，建档由系统顺手做完，人不用记任何数字。
 *   · 名称输入即出候选（分类、特征、品牌任意一段都能搜到）
 *   · 最近进过的商品点一下直接填好条码 + 名称
 *   · 提交时：条码没档案就自动建；没条码就沿用同名档案的码，确实没有才发新 NB 号
 * ====================================================== */

// 按关键词找档案：空格分隔的多个词要同时出现（「果蔬 蓝莓」能命中「色素-果蔬蓝莓色-法采」）
function searchMappings(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/).filter(Boolean);

    const hits = productMappings.filter(function (m) {
        const lower = String(m.productName || '').toLowerCase();
        return terms.every(function (t) { return lower.indexOf(t) !== -1; });
    });

    // 以查询词开头的排前（更像"正要找的那个"），其次按名称长度
    hits.sort(function (a, b) {
        const an = String(a.productName || ''), bn = String(b.productName || '');
        const ap = an.toLowerCase().indexOf(q) === 0 ? 0 : 1;
        const bp = bn.toLowerCase().indexOf(q) === 0 ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return an.length - bn.length;
    });
    return hits;
}

// 命中的词加粗，一眼确认是不是这一条
function markMatch(name, query) {
    let out = escapeHtml(name);
    const segs = String(query || '').trim().split(/\s+/).filter(Boolean);
    for (const t of segs) {
        const esc = escapeHtml(t);
        if (!esc) continue;
        out = out.split(esc).join('<b>' + esc + '</b>');
    }
    return out;
}

function hideNameSuggest() {
    const box = document.getElementById('nameSuggest');
    if (box) { box.hidden = true; box.innerHTML = ''; }
}

function renderNameSuggest() {
    const box = document.getElementById('nameSuggest');
    const input = document.getElementById('productName');
    if (!box || !input) return;

    const query = input.value.trim();
    if (!query) { hideNameSuggest(); return; }

    const hits = searchMappings(query).slice(0, 8);
    if (hits.length === 0) {
        box.innerHTML = '<div class="suggest-empty">没有匹配 · 继续输入就是新建</div>';
        box.hidden = false;
        return;
    }

    box.innerHTML = hits.map(function (m) {
        const code = String(m.barcode || '');
        const isNB = /^NB\d{3,}$/i.test(code);
        return '<div class="suggest-item" data-barcode="' + escapeHtml(code) + '"' +
               ' data-name="' + escapeHtml(m.productName) + '">' +
               '<span class="suggest-name">' + markMatch(m.productName, query) + '</span>' +
               '<span class="suggest-code' + (isNB ? ' is-nb' : '') + '">' + escapeHtml(code) + '</span>' +
               '</div>';
    }).join('');

    const wasHidden = box.hidden;
    box.hidden = false;

    // 刚展开且下方装不下时，把页面往上带一点，别让候选卡在屏幕外。
    // 只在首次展开时滚，不然每敲一个字都跳一下。
    if (wasHidden) {
        const rect = box.getBoundingClientRect();
        const reserve = document.body.classList.contains('has-preview-banner') ? 46 : 8;
        const limit = window.innerHeight - reserve;
        if (rect.bottom > limit) {
            window.scrollBy(0, Math.min(rect.bottom - limit, 180));
        }
    }
}

// 点候选项：填名称；条码没填就补上（扫到的码比档案里的更可靠，不覆盖）
function pickNameSuggest(item) {
    const name = item.getAttribute('data-name') || '';
    const code = item.getAttribute('data-barcode') || '';
    const nameInput = document.getElementById('productName');
    const bcInput = document.getElementById('barcode');

    if (nameInput) nameInput.value = name;

    if (bcInput) {
        if (!bcInput.value.trim()) {
            bcInput.value = code;
        } else if (bcInput.value.trim() !== code) {
            showToast('扫到的条码与「' + name + '」的档案不一致，提交时会以档案为准', '#ff9800', 5000);
        }
    }

    hideNameSuggest();
    handleBarcodeChange();

    const pd = document.getElementById('productionDate');
    if (pd) pd.focus();
}

// 芯片上只显示「分类-特征」，太长会撑破一行
function compactName(name) {
    const segs = String(name || '').split('-');
    let s = segs.slice(0, 2).join('-');
    if (s.length > 11) s = s.slice(0, 10) + '…';
    return escapeHtml(s);
}

// 最近录入的 10 个商品，点一下直接填好条码 + 名称
function renderRecentStrip() {
    const strip = document.getElementById('recentStrip');
    const chips = document.getElementById('recentChips');
    if (!strip || !chips) return;

    const seen = new Set();
    const list = [];
    const sorted = products.slice().sort(function (a, b) {
        return String(b.createdAt || b.updatedAt || '')
            .localeCompare(String(a.createdAt || a.updatedAt || ''));
    });

    for (let i = 0; i < sorted.length; i++) {
        const p = sorted[i];
        const key = String(p.barcode || '') + '|' + String(p.productName || '');
        if (!p.productName || seen.has(key)) continue;
        seen.add(key);
        list.push(p);
        if (list.length >= 10) break;
    }

    if (list.length === 0) { strip.hidden = true; return; }

    chips.innerHTML = list.map(function (p) {
        return '<button type="button" class="recent-chip"' +
               ' data-barcode="' + escapeHtml(p.barcode) + '"' +
               ' data-name="' + escapeHtml(p.productName) + '"' +
               ' title="' + escapeHtml(p.productName) + '">' +
               compactName(p.productName) + '</button>';
    }).join('');
    strip.hidden = false;
}

function pickRecent(chip) {
    const code = chip.getAttribute('data-barcode') || '';
    const name = chip.getAttribute('data-name') || '';
    document.getElementById('barcode').value = code;
    document.getElementById('productName').value = name;
    hideNameSuggest();
    handleBarcodeChange();

    const pd = document.getElementById('productionDate');
    if (pd) pd.focus();
}

/* ===================== 4.6 包装方式 =====================
 * 包装是商品档案（条码）的属性，不是某一批的属性 —— 同一件货不会今天瓶装明天袋装。
 * 存进 mappings.packageType，跟着商品走，换设备同步一次就一致。
 *
 * 为什么必须用固定词表：这个词是自检表分组的键。写成「瓶子」「塑料装的」这类
 * 自创说法，同一类货就分不到一组，盘点时按货架走的那条线就断了。
 * 留空 = 还没看清是什么装，和「散装」（没有容器）不是一回事。
 * ================================================== */
const PACKAGE_OPTIONS = ['瓶装', '袋装', '罐装', '盒装', '桶装', '条装', '玻璃瓶', '散装'];

// 生成 <option>，current 命中的那个选中；空值那一项的文案可定制
// （表单里有「包装方式:」这个 label，写「未填」就够了；
//   映射管理那边没有 label，得写全「包装方式：未填」才知道这格是什么）
function packageOptionsHtml(current, emptyLabel) {
    const cur = String(current || '').trim();
    let html = '<option value="">' + (emptyLabel || '未填') + '</option>';
    PACKAGE_OPTIONS.forEach(function (p) {
        html += '<option value="' + p + '"' + (p === cur ? ' selected' : '') + '>' + p + '</option>';
    });
    return html;
}

// 取某个条码档案里的包装
function getMappingPackage(barcode) {
    const code = String(barcode || '').trim();
    if (!code) return '';
    const m = productMappings.find(function (x) {
        return String(x.barcode || '').trim() === code;
    });
    return m ? String(m.packageType || '').trim() : '';
}

// 改档案里的包装。返回 true 表示真的改了（用于决定要不要提示）
function setMappingPackage(barcode, packageType) {
    const code = String(barcode || '').trim();
    if (!code) return false;

    const m = productMappings.find(function (x) {
        return String(x.barcode || '').trim() === code;
    });
    if (!m) return false;

    const val = String(packageType || '').trim();
    if (String(m.packageType || '').trim() === val) return false;

    m.packageType = val;
    touchRecord(m);        // 包装也算一次修改，别的设备要能收到
    saveMappings();
    return true;
}

/* ===================== 4.7 搜索框旁的「加一批」 =====================
 * 日常真正反复发生的动作是「又到了一批货」，不是「新建一个商品」。
 * 所以入口就放在最常用的搜索框：打两三个字 → 出候选 → 挑一条 → 只填日期。
 * 只有「从来没进过的货」才需要专门去「添加商品」（那边能扫码、能填全）。
 * ================================================== */

let assistState = null;   // { mode:'existing'|'new', barcode, name, query }

function hideListAssist() {
    const box = document.getElementById('listAssist');
    assistState = null;
    if (!box) return;
    box.hidden = true;
    box.innerHTML = '';
}

// 名称和条码两个方向都找：输一串数字基本就是奔着条码去的，命中的排前面
function searchMappingsSmart(query) {
    const q = String(query || '').trim();
    if (!q) return [];

    const lower = q.toLowerCase();
    const byCode = productMappings.filter(function (m) {
        return String(m.barcode || '').toLowerCase().indexOf(lower) !== -1;
    });
    const byName = searchMappings(q);

    const seen = new Set();
    const out = [];
    byCode.concat(byName).forEach(function (m) {
        const key = String(m.barcode || '') + '|' + String(m.productName || '');
        if (seen.has(key)) return;
        seen.add(key);
        out.push(m);
    });
    return out;
}

// 搜索框内容变了就重画助手。面板展开期间（人正在填日期）不打断，
// 除非搜索框里的字又变了 —— 那说明他换目标了
function renderListAssist() {
    const input = document.getElementById('productSearch');
    if (!input) return;

    const query = input.value.trim();
    if (!query) { hideListAssist(); return; }
    if (assistState && assistState.query === query) return;

    assistState = null;
    renderAssistCandidates(query);
}

function renderAssistCandidates(query) {
    const box = document.getElementById('listAssist');
    if (!box) return;

    const hits = searchMappingsSmart(query).slice(0, 6);
    let html = '';

    if (hits.length) {
        html += '<div class="assist-head">又到了一批？挑一个直接记：</div><div class="assist-items">';
        html += hits.map(function (m) {
            const code = String(m.barcode || '');
            const isNB = /^NB\d{3,}$/i.test(code);
            return '<button type="button" class="assist-item"' +
                   ' data-barcode="' + escapeHtml(code) + '"' +
                   ' data-name="' + escapeHtml(m.productName) + '">' +
                   '<span class="assist-name">' + markMatch(m.productName, query) + '</span>' +
                   '<span class="assist-code' + (isNB ? ' is-nb' : '') + '">' + escapeHtml(code) + '</span>' +
                   '<span class="assist-go">＋ 加一批</span>' +
                   '</button>';
        }).join('');
        html += '</div>';
    }

    html += '<div class="assist-new">' +
            (hits.length ? '都不是这个？' : '库里没有「' + escapeHtml(query) + '」，') +
            '<button type="button" class="assist-new-btn" data-name="' + escapeHtml(query) + '">' +
            '当新商品录</button></div>';

    box.innerHTML = html;
    box.hidden = false;
}

// 展开就地录入面板。mode='existing' 用档案里已定的条码；
// mode='new' 多给一个条码框（有真码就填/扫，没有就留空由系统发号）
function openBatchPanel(mode, barcode, name) {
    const box = document.getElementById('listAssist');
    const searchInput = document.getElementById('productSearch');
    if (!box) return;

    assistState = {
        mode: mode,
        barcode: barcode,
        name: name,
        query: searchInput ? searchInput.value.trim() : ''
    };

    const isNB = /^NB\d{3,}$/i.test(String(barcode || ''));

    let html = '<div class="batch-panel">';
    html += '<div class="batch-target">' +
              '<span class="batch-mode' + (mode === 'new' ? ' is-new' : '') + '">' +
                (mode === 'new' ? '新商品' : '已在库里') + '</span>' +
              '<input type="text" class="batch-name-input" id="batchNameInput" readonly value="' +
                escapeHtml(name) + '">' +
              (mode === 'new'
                ? '<input type="text" class="batch-code-input" id="batchCodeInput" ' +
                  'placeholder="条码（没有就留空，系统自动发号）" autocomplete="off">'
                : '<span class="assist-code' + (isNB ? ' is-nb' : '') + '">' + escapeHtml(barcode) + '</span>') +
            '</div>';

    html += '<div class="batch-fields">' +
              '<label>包装<select id="batchPackage">' +
                packageOptionsHtml(getMappingPackage(barcode)) +
              '</select></label>' +
              '<label>生产日期<input type="date" id="batchProductionDate"></label>' +
              '<label>保质期<span class="inline-pair">' +
                '<input type="number" id="batchShelfLife" min="1" placeholder="数量">' +
                '<select id="batchShelfLifeUnit">' +
                  '<option value="天">天</option>' +
                  '<option value="月" selected>个月</option>' +
                  '<option value="年">年</option>' +
                '</select></span></label>' +
              '<label>有效期<input type="date" id="batchValidity"></label>' +
            '</div>';

    html += '<div class="batch-actions">' +
              '<button type="button" class="btn btn-primary" id="batchSaveBtn">记一条</button>' +
              '<button type="button" class="btn btn-secondary" id="batchRenameBtn">改名</button>' +
              '<button type="button" class="btn btn-secondary" id="batchBackBtn">换商品</button>' +
            '</div>';
    html += '</div>';

    box.innerHTML = html;
    box.hidden = false;

    const pd = document.getElementById('batchProductionDate');
    if (pd) pd.focus();
}

// 从三个输入算有效期，和主表单的算法保持一致
function computeValidityFrom(productionDateStr, amount, unit) {
    const d = parseDateLocal(productionDateStr);
    const n = parseInt(amount, 10);
    if (!d || !n || n <= 0) return '';

    let exp;
    if (unit === '天') {
        exp = new Date(d.getTime());
        exp.setDate(exp.getDate() + n);
    } else if (unit === '年') {
        exp = addMonthsClamped(d, n * 12);
    } else {
        exp = addMonthsClamped(d, n);
    }
    return formatDateLocal(exp);
}

// 面板里的日期联动：填了生产日期 + 保质期就自动算出有效期
function syncBatchValidity() {
    const pd = document.getElementById('batchProductionDate');
    const sl = document.getElementById('batchShelfLife');
    const unit = document.getElementById('batchShelfLifeUnit');
    const validity = document.getElementById('batchValidity');
    if (!pd || !sl || !validity) return;

    const v = computeValidityFrom(pd.value, sl.value, unit ? unit.value : '月');
    if (v) validity.value = v;
}

// 「记一条」：名称/条码已是档案里确定的值，这里只补日期，不再走一遍建档判断
function saveBatchRecord() {
    if (!assistState) return;

    const nameInput = document.getElementById('batchNameInput');
    const validityInput = document.getElementById('batchValidity');
    const name = String(nameInput ? nameInput.value : '').trim();
    const validity = validityInput ? validityInput.value : '';

    if (!name) {
        showToast('商品名称不能为空', '#f44336');
        return;
    }
    if (!validity) {
        showToast('有效期还没填', '#f44336');
        if (validityInput) validityInput.focus();
        return;
    }

    // 名称被改过：整个条码下的记录 + 映射一起改名。不可逆，先问一句
    if (name !== assistState.name && assistState.mode === 'existing') {
        const ok = window.confirm(
            '把名称改成「' + name + '」？\n\n' +
            '这个条码下的所有记录（含已处理的）会一起改名，映射表也同步。\n' +
            '历史记录里不会保留旧名字。'
        );
        if (!ok) return;

        const m = productMappings.find(function (x) {
            return String(x.barcode || '').trim() === String(assistState.barcode).trim();
        });
        if (m) {
            m.productName = name;
            m.updatedAt = new Date().toISOString();
            saveMappings();
        }
        syncProductNames(assistState.barcode, name);
        assistState.name = name;
    }

    let barcode = assistState.barcode;

    if (assistState.mode === 'new') {
        const codeInput = document.getElementById('batchCodeInput');
        const raw = codeInput ? codeInput.value.trim() : '';
        const resolved = resolveBarcodeAndName(raw, name);
        barcode = resolved.barcode;
        assistState.barcode = barcode;      // 已建档，后面连记几条都沿用这个码
        assistState.mode = 'existing';
        assistState.name = resolved.productName;
        if (resolved.note) showToast(resolved.note, '#4caf50', 3000);
    }

    const pd = document.getElementById('batchProductionDate');
    const sl = document.getElementById('batchShelfLife');
    const unit = document.getElementById('batchShelfLifeUnit');
    const pkgSelect = document.getElementById('batchPackage');

    // 包装记在档案上（不是这一批）：这里选了什么，这个条码以后都按它显示。
    // 放在条码确定之后 —— 新商品第一次提交时档案刚建好，正好顺手补上
    if (pkgSelect) setMappingPackage(barcode, pkgSelect.value);

    // 借 FormData 走一遍 buildProductFromForm，字段口径和大表单完全一致
    const fd = new FormData();
    fd.set('barcode', barcode);
    fd.set('productName', name);
    fd.set('productionDate', pd ? pd.value : '');
    fd.set('shelfLife', sl ? sl.value : '');
    fd.set('validity', validity);

    products.push(buildProductFromForm(fd, unit ? unit.value : '月'));

    saveProducts();
    updateProductList();
    updateMappingList();
    updateReminder();
    renderRecentStrip();

    // 清掉日期，面板留着 —— 连着记几条不用重新挑商品
    if (pd) pd.value = '';
    if (sl) sl.value = '';
    if (validityInput) validityInput.value = '';
    if (pd) pd.focus();

    showToast('已记一条：' + name, '#4caf50', 2500);
}

// 找同名档案（名称完全一致），用于「没码的商品复购沿用旧码」
function findMappingByName(name) {
    const n = String(name || '').trim();
    if (!n) return null;
    return productMappings.find(function (m) {
        return String(m.productName || '').trim() === n;
    }) || null;
}

// 发新内部码：取现有 NB 号最大值 +1（同时扫商品记录，防止档案丢了导致重号）
function nextInternalCode() {
    let max = 0;
    const scan = function (code) {
        const mt = /^NB(\d{3,})$/i.exec(String(code || '').trim());
        if (mt) {
            const n = parseInt(mt[1], 10);
            if (n > max) max = n;
        }
    };
    productMappings.forEach(function (m) { scan(m.barcode); });
    products.forEach(function (p) { scan(p.barcode); });
    return 'NB' + String(max + 1).padStart(4, '0');
}

// 条码没有档案就建一条，返回档案对象
function ensureMapping(barcode, productName) {
    const code = String(barcode || '').trim();
    if (!code) return null;

    const exist = productMappings.find(function (m) {
        return String(m.barcode || '').trim() === code;
    });
    if (exist) return exist;

    const now = new Date().toISOString();
    const m = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        barcode: code,
        productName: String(productName || '').trim(),
        createdAt: now,
        updatedAt: now
    };
    productMappings.push(m);
    saveMappings();
    return m;
}

// 扫到真码，但同名商品早先用内部码建过档 —— 把真码并过去，NB 号作废。
// 改条码不可逆，所以不静默做，先让用户确认。
function mergeInternalIntoReal(nbCode, realCode, name) {
    const ok = window.confirm(
        '「' + name + '」原来用内部码 ' + nbCode + ' 建档，这次扫到了真实条码 ' + realCode + '。\n\n' +
        '是否把真码并入？\n' +
        '  · 已有记录一起改成真码\n' +
        '  · 内部码 ' + nbCode + ' 作废\n\n' +
        '点「取消」则保留内部码，本次仍按 ' + nbCode + ' 记录。'
    );
    if (!ok) return false;

    const now = new Date().toISOString();

    const m = productMappings.find(function (x) {
        return String(x.barcode || '').trim() === nbCode;
    });
    if (m) {
        m.barcode = realCode;
        m.updatedAt = now;
    } else {
        productMappings.push({
            id: Date.now() + Math.floor(Math.random() * 1000),
            barcode: realCode, productName: name, createdAt: now, updatedAt: now
        });
    }

    // 同一件货的历史记录一起改，否则列表里会留一堆指向旧 NB 号的记录
    products.forEach(function (p) {
        if (String(p.barcode || '').trim() === nbCode) {
            p.barcode = realCode;
            p.updatedAt = now;
        }
    });

    saveMappings();
    saveProducts();
    updateMappingList();
    updateProductList();
    return true;
}

/* ===================== 5. 商品表单 ===================== */
// 处理条码输入变化：已建档就带出名称，没建档就提示「输入名称即可」
function handleBarcodeChange() {
    const barcodeInput = document.getElementById('barcode');
    const barcode = barcodeInput ? barcodeInput.value.trim() : '';
    const productNameInput = document.getElementById('productName');
    const hint = document.getElementById('barcodeHint');
    if (!productNameInput) return;

    if (!barcode) {
        if (hint) { hint.hidden = true; hint.textContent = ''; }
        return;
    }

    const mapping = productMappings.find(function(item) { return item.barcode === barcode; });

    if (mapping) {
        // 已建档：带出名称
        productNameInput.value = mapping.productName;

        // 包装也一起带出来（存在档案上），省得每次重选；
        // 万一值不在词表里（老数据自创的写法），就退回「未填」，不硬塞
        const pkgEl = document.getElementById('productPackage');
        if (pkgEl) {
            const p = String(mapping.packageType || '').trim();
            pkgEl.value = PACKAGE_OPTIONS.indexOf(p) !== -1 ? p : '';
        }

        if (hint) {
            hint.hidden = false;
            hint.className = 'field-hint is-ok';
            hint.textContent = '✓ 已建档，名称自动带出';
        }
    } else {
        // 新条码：保留手填内容，别清空
        if (hint) {
            hint.hidden = false;
            hint.className = 'field-hint is-new';
            hint.textContent = '新条码 · 填名称后提交，会自动建档';
        }
    }
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

/* ---------- 建档：条码 ↔ 名称，由系统顺手完成 ----------
 * 「添加商品」表单和搜索框旁的「加一批」共用这一段。
 * 两处各写一套判断的话，改了一处忘另一处，同一件货就会分裂成两个档案
 * —— 这正是之前自编码混乱的老病根。
 * 返回 { barcode, productName, note }，note 用来告诉人系统做了什么。
 */
function resolveBarcodeAndName(rawBarcode, rawName) {
    let barcode = String(rawBarcode || '').trim();
    let productName = String(rawName || '').trim();
    let note = '';

    if (!barcode) {
        // 没条码：同名档案有码就沿用（同一件货复购不该换新号），确实没有才发新号
        const same = findMappingByName(productName);
        if (same) {
            barcode = String(same.barcode || '').trim();
            note = '沿用原码 ' + barcode;
        } else {
            barcode = nextInternalCode();
            ensureMapping(barcode, productName);
            note = '新商品，已分配内部码 ' + barcode;
        }
        return { barcode: barcode, productName: productName, note: note };
    }

    const exist = productMappings.find(function (m) {
        return String(m.barcode || '').trim() === barcode;
    });

    if (exist) {
        // 条码已有档案：以档案名称为准，避免同一个码挂两个名字
        const kept = String(exist.productName || '').trim();
        if (kept && kept !== productName) {
            showToast('该条码已建档为「' + kept + '」，已按档案名记录', '#ff9800', 5000);
            productName = kept;
        }
        return { barcode: barcode, productName: productName, note: note };
    }

    // 新条码：先看有没有同名的内部码档案 —— 是同一件货就该并入，不该分裂成两条
    const nbSame = productMappings.find(function (m) {
        return String(m.productName || '').trim() === productName &&
               /^NB\d{3,}$/i.test(String(m.barcode || '').trim());
    });

    if (nbSame) {
        const nb = String(nbSame.barcode).trim();
        if (mergeInternalIntoReal(nb, barcode, productName)) {
            note = '真码已并入，内部码 ' + nb + ' 作废';
        } else {
            barcode = nb;
            note = '保留原内部码 ' + barcode;
        }
    } else {
        ensureMapping(barcode, productName);
        note = '新商品，已建档';
    }

    return { barcode: barcode, productName: productName, note: note };
}

// 处理商品表单提交
// 「添加」和「编辑」走同一套逻辑：都往 products 里 push 一条新记录。
// 编辑 = 重新添加一条：uid、扫描日期、类型、创建时间全部按新记录生成，
// 原来那条记录原样保留 —— 不做原地覆盖，同一条码的不同批次可以各留一条。
function handleProductSubmit(e) {
    e.preventDefault();

    const form = e.target;
    const formData = new FormData(form);
    const editingId = form.dataset.editingId;   // 有值 = 从列表里点过「编辑」

    const shelfLifeUnitInput = document.getElementById('shelfLifeUnit');
    const shelfLifeUnit = shelfLifeUnitInput ? shelfLifeUnitInput.value : '月';

    let barcode = String(formData.get('barcode') || '').trim();
    let productName = String(formData.get('productName') || '').trim();
    let note = '';

    if (!productName) {
        showToast('商品名称不能为空', '#f44336');
        return;
    }

    const resolved = resolveBarcodeAndName(barcode, productName);
    barcode = resolved.barcode;
    productName = resolved.productName;
    note = resolved.note;

    // 把确定后的条码/名称写回，后面构造记录直接用
    formData.set('barcode', barcode);
    formData.set('productName', productName);

    // 包装存在档案上（跟着条码走），不写进这条批次记录
    const pkgEl = document.getElementById('productPackage');
    if (pkgEl) setMappingPackage(barcode, pkgEl.value);

    products.push(buildProductFromForm(formData, shelfLifeUnit));

    saveProducts();
    updateProductList();
    updateMappingList();
    updateReminder();
    renderRecentStrip();

    resetProductForm();

    alert((editingId ? '已按修改后的内容新增一条记录，原来那条仍保留在列表里。' : '商品添加成功！') +
          (note ? '\n\n' + note : ''));
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

    // 应用搜索过滤。空格分隔的多个词要同时命中，和上方候选的口径保持一致 ——
    // 否则输入「色素 蓝莓」时候选出两条、列表却说没有，看着像坏了
    if (productSearchQuery) {
        const terms = productSearchQuery.toLowerCase().split(/\s+/).filter(Boolean);
        displayProducts = displayProducts.filter(function(p) {
            const name = (p.productName || '').toLowerCase();
            const code = String(p.barcode || '').toLowerCase();
            return terms.every(function(t) {
                return name.indexOf(t) !== -1 || code.indexOf(t) !== -1;
            });
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
        } else if (productSearchQuery) {
            // 搜索没结果时说成「没有待处理的商品」会很误导，直接点明是没搜到
            tip = '没有匹配「' + productSearchQuery + '」的商品';
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
// 实现已经抽到 shared/dates.js，这里只是保留原来的名字
function getDaysLeft(validity) {
    return daysLeft(validity);
}

// 获取到期状态。阈值来自接口下发的 remindDays（见 applyRemoteConfig），
// 不再是写死在页面里的 30 —— 否则会出现「页面标红说紧急、微信推送却没提」这种对不上的情况
function getExpiryStatus(validity) {
    return getExpiryStatusFor(validity, remindDays);
}

// 说明：getStatusText / getStatusLabel 直接来自 shared/dates.js（见文件顶部挂载），
// 页面原来那两份实现已经删掉，改成三处（页面 / 两个云函数）共用同一份

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

        const pkg = String(mapping.packageType || '').trim();

        row.innerHTML = `
            <td>${index + 1}</td>
            <td>${escapeHtml(mapping.barcode)}</td>
            <td>${escapeHtml(mapping.productName)}</td>
            <td>${pkg ? escapeHtml(pkg) : '<span class="pkg-empty">未填</span>'}</td>
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

        // 包装不在批次记录里，从档案上取
        const pkgEl = document.getElementById('productPackage');
        if (pkgEl) {
            const p = getMappingPackage(product.barcode);
            pkgEl.value = PACKAGE_OPTIONS.indexOf(p) !== -1 ? p : '';
        }

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
    pushTombstonesQuietly('商品删除');
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
    const pkgEl = document.getElementById('newPackage');
    const packageType = pkgEl ? pkgEl.value : '';
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
                packageType: packageType,
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
            if (pkgEl) pkgEl.value = '';

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
            productMappings[existingIndex].packageType = packageType;
            touchRecord(productMappings[existingIndex]);
            syncProductNames(barcode, productName);
        } else {
            // 添加新映射
            productMappings.push({
                id: Date.now(),
                barcode: barcode,
                productName: productName,
                packageType: packageType,
                updatedAt: new Date().toISOString()
            });
        }

        saveMappings();
        updateMappingList();

        document.getElementById('newBarcode').value = '';
        document.getElementById('newProductName').value = '';
        if (pkgEl) pkgEl.value = '';

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

        // 包装一起带出来（老档案没有这个字段 = 未填）
        const pkgEl = document.getElementById('newPackage');
        if (pkgEl) {
            const p = String(mapping.packageType || '').trim();
            pkgEl.value = PACKAGE_OPTIONS.indexOf(p) !== -1 ? p : '';
        }

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

    pushTombstonesQuietly('映射删除');
};

/* ===================== 8. CSV 导入导出 ===================== */
// CSV 的拼装与解析都在 shared/csv.js（有测试覆盖，云函数也用同一份）；
// 这里只负责下载、读取文件、并回本地数据。
// 处置相关的 3 列追加在最后：导入时按位置读前 8 列，所以老备份文件依然能导入。

// 导出CSV（商品 + 映射，导出文件本身就是一份完整备份）
function exportToCSV() {
    if (products.length === 0 && productMappings.length === 0) {
        alert('没有数据可以导出！');
        return;
    }

    const csvContent = buildCsvText(products, productMappings, {
        getStatusText: getStatusText,
        getExpiryStatus: getExpiryStatus,
        formatShelfLife: formatShelfLife
    });

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

// 导入CSV
// 解析交给 shared/csv.js（引号、逗号、换行、BOM、老 8 列文件都在那边处理）
function importFromCSV(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(event) {
        const rows = parseCsvText(stripBom(String(event.target.result || '')));

        if (rows.length < 2) {
            alert('CSV文件格式不正确！');
            return;
        }

        const parsed = csvRowsToRecords(rows, { makeUid: makeUid, todayLocal: todayLocal });

        // 商品并入本地：导入的记录带 uid 和更新时间，同步时按新旧正常合并
        products = products.concat(parsed.products);

        // 映射按条码唯一：同一个条码在文件里重复出现时以最后一条为准
        parsed.mappings.forEach(function(mapping) {
            const at = productMappings.findIndex(function(m) { return m.barcode === mapping.barcode; });
            if (at >= 0) productMappings[at] = mapping;
            else productMappings.push(mapping);
        });

        saveProducts();
        saveMappings();
        updateProductList();
        updateMappingList();

        alert('成功导入 ' + parsed.productCount + ' 条商品记录和 ' + parsed.mappingCount + ' 条映射记录！');
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


/* ===================== 10. 数据同步 ===================== */
// 两个按钮的分工（合并都在服务端做，所以两边都不会丢数据）：
//   · 同步数据   —— 把本机改动上传：服务端先与云端合并，再写回，不会覆盖别的设备的改动
//   · 获取最新数据 —— 只读云端并合并回本机，不动云端；本机没上传的改动会给你提个醒
// 以前还要在这里自己合并（几百行），现在共用 shared/merge.js，云函数那份是权威实现。

// 把服务端返回的合并结果落到本机
function applyMergedData(data) {
    products = data.products || [];
    productMappings = data.mappings || [];
    productTombstones = (data.tombstones && data.tombstones.products) || [];
    mappingTombstones = (data.tombstones && data.tombstones.mappings) || [];

    saveProducts();
    saveMappings();
    saveTombstones();
    updateProductList();
    updateMappingList();
    updateReminder();
}

// 记下同步前的条数，用来算「新增 / 删除」给提示用
function snapshotCounts() {
    return {
        products: products.length,
        mappings: productMappings.length
    };
}

function diffSummary(before) {
    return {
        productAdded: Math.max(0, products.length - before.products),
        productRemoved: Math.max(0, before.products - products.length),
        mappingAdded: Math.max(0, productMappings.length - before.mappings),
        mappingRemoved: Math.max(0, before.mappings - productMappings.length)
    };
}

function describeDiff(summary) {
    return '（新增 ' + summary.productAdded + '，减少 ' + summary.productRemoved + '）';
}

// 「同步数据」用：算这次上传给云端带来了什么。
// 不能拿本机列表前后条数差来算 —— 本机新增的商品在同步前就已经在列表里了，
// 那样算永远是 0。改用云函数返回的 stats：云端同步前的条数（remoteLive）
// 和合并后的条数（products），两者之差就是本次上传新增/减少的条数
function uploadedDiff(stats) {
    const merged = stats.products !== undefined ? stats.products : products.length;
    const remote = stats.remoteLive !== undefined ? stats.remoteLive : merged;
    const mergedMappings = stats.mappings !== undefined ? stats.mappings : productMappings.length;
    const remoteMappings = stats.remoteMappings !== undefined ? stats.remoteMappings : mergedMappings;
    return {
        productAdded: Math.max(0, merged - remote),
        productRemoved: Math.max(0, remote - merged),
        mappingAdded: Math.max(0, mergedMappings - remoteMappings),
        mappingRemoved: Math.max(0, remoteMappings - mergedMappings)
    };
}

// 「同步数据」：上传本机改动
async function syncData() {
    if (!await ensureApiKey()) return;

    // 只剩墓碑也要同步：本机删空之后，「删除」这件事本身得传上去
    const localCount = products.length + productMappings.length +
                       productTombstones.length + mappingTombstones.length;
    if (localCount === 0) {
        alert('没有数据需要同步！');
        return;
    }

    showToast('正在同步数据...', '#4CAF50', 60000);

    try {
        const res = await apiRequest('push');
        applyMergedData(res.data);

        // 上传提示按「给云端带来了什么」算，不看本机列表前后差（本机新增在同步前就已在列表里）
        const summary = uploadedDiff(res.stats || {});
        console.log('同步统计', res.stats, summary);

        // 删除是「删掉就立刻静默上传墓碑」的，等你再点同步时云端早就删好了，
        // 这时一律显示 0。不加这句说明，看到「减少 0」会以为删除没同步上去
        const nothingToUpload = summary.productAdded === 0 && summary.productRemoved === 0 &&
                                summary.mappingAdded === 0 && summary.mappingRemoved === 0;

        showToast('同步完成：商品 ' + products.length + ' 条', '#45a049', 5000);
        alert('数据同步完成！\n' +
              '商品: ' + products.length + ' 条（上传新增 ' + summary.productAdded +
              '，减少 ' + summary.productRemoved + '）\n' +
              '映射: ' + productMappings.length + ' 条' +
              (summary.mappingAdded !== summary.mappingRemoved ? '（上传新增 ' + summary.mappingAdded + '，减少 ' + summary.mappingRemoved + '）' : '') +
              (nothingToUpload ? '\n\n本机与云端已经一致，本次没有新的改动要上传（删除是在删除时即时上传的）。' : ''));
    } catch (error) {
        console.error('同步失败:', error);
        showToast('同步失败：' + (error.message || '未知错误'), '#f44336', 5000);
        alert('数据同步失败：' + (error.message || '未知错误'));
    }
}

// 「获取最新数据」：只读云端，与本机合并；本机没上传的改动会提示手动上传
async function fetchLatestDataFromCloud() {
    if (!await ensureApiKey()) return;

    showToast('正在获取最新数据...', '#2196F3', 60000);

    try {
        const before = snapshotCounts();
        const res = await apiRequest('pull');
        applyMergedData(res.data);

        const summary = diffSummary(before);
        const stats = res.stats || {};

        // 本机有、云端没有的记录（pull 不写云端），提醒一句怎么上传
        const pending = Math.max(0, (stats.products || 0) - (stats.remoteLive || 0)) +
                        Math.max(0, (stats.deletedProducts || 0) - (stats.remoteTombstones || 0));

        showToast('获取完成：商品 ' + products.length + ' 条', '#45a049', 5000);
        alert('已与云端数据合并（两边谁更新用谁）！\n' +
              '商品: ' + products.length + ' 条' + describeDiff(summary) + '\n' +
              '映射: ' + productMappings.length + ' 条' +
              (pending > 0 ? '\n\n注意：本机有 ' + pending + ' 条改动还没上传，点「同步数据」即可上传。' : ''));
    } catch (error) {
        console.error('获取数据失败:', error);
        showToast('获取失败：' + (error.message || '未知错误'), '#f44336', 5000);
        alert('数据获取失败：' + (error.message || '未知错误'));
    }
}

// 删除后立刻把墓碑推上云端，不用等用户再点一次「同步数据」。
// 推不上去也不回滚：本机已经删掉了，下次点「同步数据」会把墓碑补上
async function pushTombstonesQuietly(label) {
    if (!apiKey) return;   // 还没填过口令，等点「同步数据」时一起走

    try {
        const res = await apiRequest('push');
        applyMergedData(res.data);
        // 成功也要给个回执：删除是静默上传的，一声不吭的话用户不知道云端那边已经删了，
        // 再去点「同步数据」看到「减少 0」就会以为删除没传上去
        showToast((label || '删除') + '已同步到云端：商品 ' + products.length + ' 条', '#45a049', 4000);
    } catch (error) {
        console.error('删除标记上传失败:', error);
        showToast('已在本机删除；上传失败，下次点「同步数据」会补上', '#ff9800', 5000);
    }
}

// ===================== PWA：Service Worker 与「安装 / 添加到桌面」 =====================
// 提示过一次就记下来（按域名分开存），免得每次打开都挂个按钮
const PWA_HINT_KEY = 'pwaInstallHintShown';
const MANUAL_INSTALL_HINT = [
    '把这个页面放到手机桌面：',
    '',
    '1. 点浏览器底部（或右下角）的菜单按钮（⋮ 或 ≡）',
    '2. 选「添加到桌面」或「添加到主屏幕」',
    '3. 确认后，桌面就会出现「到期提醒」图标',
    '',
    '说明：鸿蒙 / 华为浏览器没有 Google 服务，系统不会自动弹出安装提示，',
    '只能手动从菜单添加。加到桌面后，点开就用，和装的应用差不多。'
].join('\n');

// 只在 http / https 下注册；用 file:// 本地打开时不注册、不报错
function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || window.location.protocol === 'file:') {
        return;
    }

    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
        .then(function(registration) {
            console.log('Service Worker 注册成功:', registration.scope);
        })
        .catch(function(error) {
            console.error('Service Worker 注册失败:', error);
        });

    // 已经在独立窗口里跑，说明早就装过了，不再提示
    if (isStandaloneMode()) return;

    let hintShown = false;
    try { hintShown = localStorage.getItem(PWA_HINT_KEY) === '1'; } catch (e) {}

    let installPromptEvent = null;
    let systemPromptShown = false;

    // Chrome / Edge 这类带应用商店能力的浏览器会触发本事件，可以直接弹系统安装框
    window.addEventListener('beforeinstallprompt', function(event) {
        event.preventDefault();
        installPromptEvent = event;
        systemPromptShown = true;
        showPwaInstallButton('system');
    });

    // 鸿蒙（HarmonyOS NEXT）、iOS Safari 以及不少国产浏览器都不会触发上面那个事件
    //（前两者没有 Google 服务，装不了 WebAPK），只能让用户自己去菜单里「添加到桌面」。
    // 等一会儿还没等到，就给个按钮带一下路。
    if (isMobileBrowser() && !hintShown) {
        setTimeout(function() {
            if (!systemPromptShown) showPwaInstallButton('manual');
        }, 2500);
    }

    // 是否已经在「安装后的独立窗口」里运行
    function isStandaloneMode() {
        return window.matchMedia('(display-mode: standalone)').matches ||
               window.matchMedia('(display-mode: minimal-ui)').matches ||
               window.navigator.standalone === true;
    }

    function isMobileBrowser() {
        // 华为鸿蒙的 UA 里带 HarmonyOS；安卓与 iOS 一并覆盖
        return /Android|HarmonyOS|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    }

    // 两种按钮：
    //   system —— 系统支持安装，点了直接弹安装框
    //   manual —— 系统不支持（鸿蒙 / iOS），点了给一段「怎么加到桌面」的说明
    function showPwaInstallButton(mode) {
        const badge = document.querySelector('.storage-badge');
        if (!badge) return;
        if (badge.parentNode.querySelector('.install-btn')) return;

        const button = document.createElement('button');
        button.className = 'install-btn';
        button.textContent = mode === 'system' ? '安装到主屏幕' : '添加到桌面';
        button.title = mode === 'system'
            ? '安装后可在主屏幕直接打开，断网也能用'
            : '点这里看怎么把这个页面放到手机桌面';
        button.addEventListener('click', async function() {
            if (mode === 'manual') {
                markHintShown();
                alert(MANUAL_INSTALL_HINT);
                return;
            }

            if (!installPromptEvent) return;
            installPromptEvent.prompt();
            const result = await installPromptEvent.userChoice;
            if (result.outcome === 'accepted') {
                markHintShown();
                button.remove();
            }
            installPromptEvent = null;
        });

        badge.parentNode.insertBefore(button, badge.nextSibling);
    }

    function markHintShown() {
        try { localStorage.setItem(PWA_HINT_KEY, '1'); } catch (e) {}
    }
}
