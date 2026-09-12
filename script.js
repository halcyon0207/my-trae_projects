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

// 页面是否运行在 GitHub Pages 上；是则改用 GitHub 仓库作为数据存储
const IS_GITHUB_PAGES = /\.github\.io$/i.test(location.hostname) ||
                        /[?&]storage=github/i.test(location.search);   // 本地可用 ?storage=github 预览 GitHub 模式

let cbApp = null;         // CloudBase 应用实例
let cbDb = null;          // 数据库实例
let cloudReady = false;   // 云端是否已就绪
let cloudWatchers = [];   // 实时监听句柄

let ghToken = localStorage.getItem('ghToken') || '';   // GitHub 访问令牌（只存在本机）
let ghSha = null;         // 数据文件当前版本号（写入时必需）

/* ===================== 1. 本地数据 ===================== */
let products = JSON.parse(localStorage.getItem('products')) || [];
let productMappings = JSON.parse(localStorage.getItem('productMappings')) || [];

// 全局变量：当前显示模式（all 或 filter）
let currentDisplayMode = 'all';

// 全局搜索变量
let productSearchQuery = '';
let mappingSearchQuery = '';

// 图表实例
let chart;

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
                fps: 25,
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

    // 加载数据
    loadData();

    // 更新列表
    updateProductList();
    updateMappingList();

    // 初始化图表
    initializeChart();

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

    // 添加映射
    document.getElementById('addMappingBtn').addEventListener('click', addMapping);

    // 商品列表搜索
    document.getElementById('productSearchBtn').addEventListener('click', function() {
        productSearchQuery = document.getElementById('productSearch').value;
        updateProductList();
    });

    // 商品列表清空搜索
    document.getElementById('productClearSearchBtn').addEventListener('click', function() {
        document.getElementById('productSearch').value = '';
        productSearchQuery = '';
        updateProductList();
    });

    // 映射列表搜索
    document.getElementById('mappingSearchBtn').addEventListener('click', function() {
        mappingSearchQuery = document.getElementById('mappingSearch').value;
        updateMappingList();
    });

    // 映射列表清空搜索
    document.getElementById('mappingClearSearchBtn').addEventListener('click', function() {
        document.getElementById('mappingSearch').value = '';
        mappingSearchQuery = '';
        updateMappingList();
    });
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

// 处理商品表单提交
function handleProductSubmit(e) {
    e.preventDefault();

    const formData = new FormData(e.target);
    const isEditing = e.target.dataset.editingId;

    const shelfLifeUnitInput = document.getElementById('shelfLifeUnit');
    const shelfLifeUnit = shelfLifeUnitInput ? shelfLifeUnitInput.value : '月';

    if (isEditing) {
        // 编辑模式：更新现有商品（使用宽松比较，兼容字符串 / 数字类型的 id）
        const productId = isEditing;
        const productIndex = products.findIndex(function(p) { return p.id == productId; });

        if (productIndex !== -1) {
            products[productIndex] = Object.assign({}, products[productIndex], {
                barcode: formData.get('barcode'),
                productName: formData.get('productName'),
                productionDate: formData.get('productionDate'),
                shelfLife: formData.get('shelfLife'),
                shelfLifeUnit: shelfLifeUnit,
                validity: formData.get('validity')
            });

            saveProducts();
            updateProductList();
            updateChart();

            // 重置表单和编辑状态
            e.target.reset();
            delete e.target.dataset.editingId;
            document.querySelector('#productForm button[type="submit"]').textContent = '添加商品';

            alert('商品更新成功！');
        }
    } else {
        // 添加模式：创建新商品
        const product = {
            id: Date.now() + Math.floor(Math.random() * 1000),   // 避免连点两次生成相同 id
            barcode: formData.get('barcode'),
            productName: formData.get('productName'),
            type: '商品',          // 默认类型为"商品"
            scanDate: todayLocal(), // 按本地日期记录，避免晚上录入被记成前一天
            productionDate: formData.get('productionDate'),
            shelfLife: formData.get('shelfLife'),
            shelfLifeUnit: shelfLifeUnit,
            validity: formData.get('validity'),
            createdAt: new Date().toISOString()
        };

        products.push(product);

        saveProducts();
        updateProductList();
        updateChart();

        e.target.reset();

        alert('商品添加成功！');
    }
}

// 保存商品数据
function saveProducts() {
    localStorage.setItem('products', JSON.stringify(products));
}

// 保存映射数据
function saveMappings() {
    localStorage.setItem('productMappings', JSON.stringify(productMappings));
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

    // 如果是筛选模式，只显示1个月内到期的商品
    if (currentDisplayMode === 'filter') {
        displayProducts = displayProducts.filter(function(product) {
            const status = getExpiryStatus(product.validity);
            return status === 'danger' || status === 'expired';
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

    // 按到期日期排序：已过期 / 快到期排前面，没填有效期的排最后
    const sortedProducts = displayProducts.sort(function(a, b) {
        const da = parseDateLocal(a.validity);
        const db = parseDateLocal(b.validity);
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return da - db;
    });

    sortedProducts.forEach(function(product, index) {
        const row = document.createElement('tr');
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

        row.innerHTML = `
            <td>${index + 1}</td>
            <td${validityStyle}>${escapeHtml(product.validity) || '-'}</td>
            <td><span class="status status-${status}">${getStatusLabel(product.validity)}</span></td>
            <td${nameStyle}>${escapeHtml(product.productName)}</td>
            <td>${escapeHtml(product.type)}</td>
            <td>${escapeHtml(product.scanDate)}</td>
            <td>${escapeHtml(product.productionDate) || '-'}</td>
            <td>${formatShelfLife(product)}</td>
            <td>${escapeHtml(product.barcode)}</td>
            <td${actionStyle}>
                <button class="btn btn-secondary" onclick="editProduct('${product.id}')">编辑</button>
                <button class="btn btn-danger" onclick="deleteProduct('${product.id}')">删除</button>
            </td>
        `;

        tbody.appendChild(row);
    });
}

// 筛选1个月内到期的商品
function filterOneMonthExpiry() {
    // 切换显示模式
    currentDisplayMode = currentDisplayMode === 'all' ? 'filter' : 'all';

    // 更新按钮文本
    const filterBtn = document.getElementById('filterBtn');
    if (currentDisplayMode === 'filter') {
        filterBtn.textContent = '显示所有商品';
        filterBtn.classList.remove('btn-warning');
        filterBtn.classList.add('btn-success');
    } else {
        filterBtn.textContent = '筛选1个月内到期商品';
        filterBtn.classList.remove('btn-success');
        filterBtn.classList.add('btn-warning');
    }

    // 更新商品列表
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
    let product = products.find(function(p) { return p.id === id; });
    if (!product) product = products.find(function(p) { return p.id == id; });
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
        document.getElementById('productForm').dataset.editingId = id;
        document.querySelector('#productForm button[type="submit"]').textContent = '更新商品';
    } catch (error) {
        console.error('编辑功能执行失败:', error);
    }
};

// 删除商品（全局函数，以便HTML onclick事件调用）
window.deleteProduct = function(id) {
    if (!confirm('确定要删除这个商品吗？')) return;

    // 先找到要删除的商品对象，以便获取条码信息
    const productToDelete = products.find(function(p) {
        return p.id === id || p.id == id || String(p.id) === String(id);
    });

    products = products.filter(function(p) {
        return !(p.id === id || p.id == id || String(p.id) === String(id));
    });

    saveProducts();
    updateProductList();
    updateChart();

    // 同步删除云端数据（按条码匹配）
    if (productToDelete && productToDelete.barcode) {
        if (IS_GITHUB_PAGES) {
            // GitHub 存储：重新拉取 → 过滤掉该条 → 写回
            if (ghToken) {
                ghLoad()
                    .then(function(cloud) {
                        const remainProducts = cloud.products.filter(function(p) {
                            return p.barcode !== productToDelete.barcode;
                        });
                        const remainMappings = cloud.mappings.filter(function(m) {
                            return m.barcode !== productToDelete.barcode;
                        });
                        return ghSave(remainProducts, remainMappings, '删除商品：' + productToDelete.barcode);
                    })
                    .then(function() {
                        console.log('GitHub 数据已同步删除:', productToDelete.barcode);
                    })
                    .catch(function(error) {
                        console.error('GitHub 删除失败:', error);
                        showToast('云端删除失败：' + (error.message || '未知错误'), '#ff9800');
                    });
            }
        } else if (cloudReady) {
            cbDb.collection(PRODUCT_COLLECTION)
                .where({ barcode: productToDelete.barcode })
                .remove()
                .then(function() {
                    console.log('云端商品已删除:', productToDelete.barcode);
                })
                .catch(function(error) {
                    console.error('云端删除失败:', error);
                    showToast('云端删除失败：' + (error.message || '未知错误'), '#ff9800');
                });
        }
    }
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
                productName: productName
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
            syncProductNames(barcode, productName);
        } else {
            // 添加新映射
            productMappings.push({
                id: Date.now(),
                barcode: barcode,
                productName: productName
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

    productMappings = productMappings.filter(function(m) { return m.id != id; });
    saveMappings();
    updateMappingList();
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

    const headers = ['类型', '商品条码', '商品名称', '扫描日期', '有效期', '生产日期', '保质期', '状态'];
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
            getStatusText(getExpiryStatus(product.validity))
        ]);
    });

    // 映射也一起导出，否则换台设备映射就全丢了
    productMappings.forEach(function(mapping) {
        rows.push(['映射', mapping.barcode, mapping.productName, '', '', '', '', '']);
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

        // 跳过表头，顺序：类型、商品条码、商品名称、扫描日期、有效期、生产日期、保质期、状态
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const type = (row[0] || '').trim();
            const barcode = (row[1] || '').trim();
            const productName = (row[2] || '').trim();

            if (!barcode) continue;

            if (type === '商品') {
                const shelf = parseShelfLifeText(row[6]);
                products.push({
                    id: Date.now() + i,
                    type: '商品',
                    barcode: barcode,
                    productName: productName,
                    scanDate: (row[3] || '').trim(),
                    validity: (row[4] || '').trim(),
                    productionDate: (row[5] || '').trim(),
                    shelfLife: shelf.shelfLife,
                    shelfLifeUnit: shelf.shelfLifeUnit,
                    createdAt: new Date().toISOString()
                });
                productCount++;
            } else if (type === '映射') {
                const mapping = {
                    id: Date.now() + i + 1000,   // 确保ID与商品不冲突
                    barcode: barcode,
                    productName: productName
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
        updateChart();

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
    saveProducts();
    saveMappings();
    updateProductList();
    updateMappingList();
    updateChart();
    alert('所有数据已清空！');
}

/* ===================== 9. 图表 ===================== */
// 初始化图表
function initializeChart() {
    const ctx = document.getElementById('expiryChart').getContext('2d');
    chart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['正常', '1-3个月', '1个月内', '已过期'],
            datasets: [{
                label: '商品数量',
                data: getExpiryCounts(),
                backgroundColor: [
                    'rgba(76, 175, 80, 0.6)',
                    'rgba(255, 152, 0, 0.6)',
                    'rgba(244, 67, 54, 0.6)',
                    'rgba(158, 158, 158, 0.6)'
                ],
                borderColor: [
                    'rgba(76, 175, 80, 1)',
                    'rgba(255, 152, 0, 1)',
                    'rgba(244, 67, 54, 1)',
                    'rgba(158, 158, 158, 1)'
                ],
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { precision: 0 }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return `商品数量: ${context.raw}`;
                        }
                    }
                }
            }
        }
    });
}

// 获取到期数量统计
function getExpiryCounts() {
    const counts = { normal: 0, warning: 0, danger: 0, expired: 0, unknown: 0 };

    products.forEach(function(product) {
        const status = getExpiryStatus(product.validity);
        if (counts[status] === undefined) return;   // 未填有效期的记录不进图表
        counts[status]++;
    });

    return [counts.normal, counts.warning, counts.danger, counts.expired];
}

// 更新图表
function updateChart() {
    if (chart) {
        chart.data.datasets[0].data = getExpiryCounts();
        chart.update();
    }
}

// 加载数据
function loadData() {
    products = JSON.parse(localStorage.getItem('products')) || [];
    productMappings = JSON.parse(localStorage.getItem('productMappings')) || [];
}

/* ===================== 10. 云端同步 ===================== */
// 同步本地数据到云端（按条码匹配：有则更新，无则新增）
async function syncData() {
    /* ---- GitHub 存储：本地与云端合并后写回 ---- */
    if (IS_GITHUB_PAGES) {
        if (!await ensureGhToken()) return;

        if (products.length + productMappings.length === 0) {
            alert('没有数据需要同步！');
            return;
        }

        showToast('正在同步数据到 GitHub ...', '#4CAF50', 60000);

        try {
            const cloud = await ghLoad();

            // 按条码合并，本地数据优先，避免在新设备上同步时清空云端
            const productMap = {};
            cloud.products.forEach(function(p) { if (p.barcode) productMap[p.barcode] = p; });
            products.forEach(function(p) { if (p.barcode) productMap[p.barcode] = p; });

            const mappingMap = {};
            cloud.mappings.forEach(function(m) { if (m.barcode) mappingMap[m.barcode] = m; });
            productMappings.forEach(function(m) { if (m.barcode) mappingMap[m.barcode] = m; });

            const mergedProducts = Object.keys(productMap).map(function(k) { return productMap[k]; });
            const mergedMappings = Object.keys(mappingMap).map(function(k) { return mappingMap[k]; });

            await ghSave(mergedProducts, mergedMappings, '同步商品数据');

            products = mergedProducts;
            productMappings = mergedMappings;
            saveProducts();
            saveMappings();
            updateProductList();
            updateMappingList();
            updateChart();

            showToast('同步完成：商品 ' + mergedProducts.length + ' 条', '#45a049', 5000);
            alert('数据同步完成！\n商品: ' + mergedProducts.length + ' 条\n映射: ' + mergedMappings.length + ' 条');
        } catch (error) {
            console.error('GitHub 同步失败:', error);
            showToast('同步失败：' + (error.message || '未知错误'), '#f44336', 5000);
            alert('数据同步失败：' + (error.message || '未知错误'));
        }
        return;
    }

    if (!await ensureCloud()) return;

    const totalItems = products.length + productMappings.length;
    if (totalItems === 0) {
        alert('没有数据需要同步！');
        return;
    }

    showToast('正在同步数据到云端...', '#4CAF50', 60000);

    try {
        const productResult = await upsertCollection(PRODUCT_COLLECTION, products);
        const mappingResult = await upsertCollection(MAPPING_COLLECTION, productMappings);

        const successCount = productResult.success + mappingResult.success;
        const failCount = productResult.fail + mappingResult.fail;

        showToast(
            '数据同步完成：成功 ' + successCount + ' 项，失败 ' + failCount + ' 项',
            failCount === 0 ? '#45a049' : '#ff9800',
            5000
        );
        alert('数据同步完成！\n共 ' + totalItems + ' 项\n成功: ' + successCount + ' 项\n失败: ' + failCount + ' 项');
    } catch (error) {
        console.error('数据同步失败:', error);
        showToast('同步失败：' + (error.message || '未知错误'), '#f44336', 5000);
        alert('数据同步失败：' + (error.message || '未知错误'));
    }
}

// 把本地数组按 barcode 写入云端集合
async function upsertCollection(collectionName, localItems) {
    const fields = collectionName === PRODUCT_COLLECTION
        ? ['barcode', 'productName', 'type', 'scanDate', 'productionDate', 'shelfLife', 'shelfLifeUnit', 'validity']
        : ['barcode', 'productName'];

    // 1. 拉取云端已有记录，建立 barcode -> _id 映射
    const cloudItems = await fetchAllFromCloud(collectionName);
    const idByBarcode = {};
    cloudItems.forEach(function(doc) {
        idByBarcode[doc.barcode] = doc._id;
    });

    // 2. 区分「需新增」和「需更新」
    const toAdd = [];
    const toUpdate = [];

    localItems.forEach(function(item) {
        if (item.barcode === undefined || item.barcode === null || item.barcode === '') return;

        const data = {};
        fields.forEach(function(field) {
            data[field] = item[field] === undefined || item[field] === null ? '' : item[field];
        });

        const existedId = idByBarcode[item.barcode];
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

// 从云端获取最新数据（覆盖本地）
async function fetchLatestDataFromCloud() {
    /* ---- GitHub 存储 ---- */
    if (IS_GITHUB_PAGES) {
        if (!await ensureGhToken()) return;

        showToast('正在从 GitHub 获取最新数据 ...', '#2196F3', 60000);

        try {
            const cloud = await ghLoad();

            if (cloud.products.length > 0) {
                products = cloud.products.map(function(p) {
                    return Object.assign({
                        id: p.id || p.barcode,
                        type: '商品',
                        scanDate: '',
                        productionDate: '',
                        shelfLife: '',
                        shelfLifeUnit: '月',
                        validity: ''
                    }, p);
                });
                saveProducts();
                updateProductList();
                updateChart();
            }

            if (cloud.mappings.length > 0) {
                productMappings = cloud.mappings.map(function(m) {
                    return Object.assign({ id: m.id || m.barcode }, m);
                });
                saveMappings();
                updateMappingList();
            }

            showToast('获取完成：商品 ' + cloud.products.length + ' 条', '#45a049', 5000);
            alert('成功从 GitHub 获取最新数据！\n商品: ' + cloud.products.length + ' 条\n映射: ' + cloud.mappings.length + ' 条');
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
        const cloudProducts = await fetchAllFromCloud(PRODUCT_COLLECTION);
        const cloudMappings = await fetchAllFromCloud(MAPPING_COLLECTION);

        // 商品数据（有云端数据时才覆盖本地，避免误清空）
        if (cloudProducts.length > 0) {
            products = cloudProducts.map(function(doc) {
                return {
                    id: doc._id,                       // 使用云端 _id 作为唯一标识
                    barcode: doc.barcode,
                    productName: doc.productName,
                    type: doc.type || '商品',
                    scanDate: doc.scanDate || '',
                    productionDate: doc.productionDate || '',
                    shelfLife: doc.shelfLife || '',
                    shelfLifeUnit: doc.shelfLifeUnit || '月',
                    validity: doc.validity || '',
                    createdAt: doc._createTime
                        ? new Date(doc._createTime).toISOString()
                        : new Date().toISOString()
                };
            });
            saveProducts();
            updateProductList();
            updateChart();
        }

        // 映射数据
        if (cloudMappings.length > 0) {
            productMappings = cloudMappings.map(function(doc) {
                return {
                    id: doc._id,
                    barcode: doc.barcode,
                    productName: doc.productName
                };
            });
            saveMappings();
            updateMappingList();
        }

        showToast(
            '数据获取完成：商品 ' + cloudProducts.length + ' 条，映射 ' + cloudMappings.length + ' 条',
            '#45a049',
            5000
        );
        alert('成功从云端获取最新数据！\n商品: ' + cloudProducts.length + ' 条\n映射: ' + cloudMappings.length + ' 条');
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
