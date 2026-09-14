'use strict';

/*
 * 前端加载测试：在 Node 里搭一个最小 DOM，把 shared/*.js 和 script.js 按页面的顺序执行一遍。
 *
 * 它抓的是这类问题：删掉旧代码后还有函数引用它（页面一打开就报错，但单测全绿）。
 * 顺带检查共享模块有没有按预期挂到全局 —— 页面靠 window 上的这些函数工作，
 * 一旦脚本顺序写错（shared 没加载）这里会直接失败。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function makeElement() {
    const el = {
        style: {},
        dataset: {},
        innerHTML: '',
        textContent: '',
        className: '',
        files: [],
        parentNode: null,
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {},
        removeEventListener() {},
        appendChild() {},
        removeChild() {},
        setAttribute() {},
        removeAttribute() {},
        click() {},
        reset() {},
        contains() { return false; },
        querySelector: () => el,        // 页面结构不参与测试，任何查询都返回同一个桩元素
        querySelectorAll: () => []
    };
    return el;
}

function makeSandbox() {
    const listeners = {};
    const element = makeElement();

    const document = {
        addEventListener: (name, fn) => { listeners[name] = fn; },
        querySelector: () => element,
        querySelectorAll: () => [],
        getElementById: () => element,
        createElement: () => makeElement(),
        body: element,
        head: element
    };

    const sandbox = {
        console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
        document: document,
        navigator: {},   // 故意没有 serviceWorker：和 file:// 打开一样，跳过注册
        location: { protocol: 'https:', search: '', hostname: 'example.com' },
        localStorage: {
            _data: {},
            getItem(k) { return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
            setItem(k, v) { this._data[k] = String(v); },
            removeItem(k) { delete this._data[k]; }
        },
        setTimeout: () => 0,
        clearTimeout: () => {},
        alert: () => {},
        confirm: () => true,
        prompt: () => null,
        fetch: () => Promise.reject(new Error('测试环境不联网')),
        Blob: function () {},
        URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
        FileReader: function () {},
        TextEncoder: TextEncoder,
        TextDecoder: TextDecoder,
        listeners: listeners
    };

    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    return vm.createContext(sandbox);
}

function loadInto(context, relativePath) {
    const code = fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');
    vm.runInContext(code, context, { filename: relativePath });
}

test('shared/*.js 与 script.js 按页面顺序加载后不报错，且关键函数都在 window 上', () => {
    const context = makeSandbox();

    // 顺序必须和 index.html 一致
    loadInto(context, 'shared/dates.js');
    loadInto(context, 'shared/merge.js');
    loadInto(context, 'shared/csv.js');
    loadInto(context, 'script.js');

    const expected = [
        // 共享模块（三处共用，页面靠 window 访问）
        'daysLeft', 'getExpiryStatusFor', 'getStatusText', 'getStatusLabel', 'formatShelfLife',
        'makeUid', 'ensureProductUids', 'makeProductTombstone', 'makeMappingTombstone', 'touchRecord',
        'mergeProducts', 'mergeMappings',
        'buildCsvText', 'parseCsvText', 'stripBom', 'csvRowsToRecords',
        // 页面自己的
        'initializeApp', 'syncData', 'fetchLatestDataFromCloud', 'pushTombstonesQuietly',
        'applyMergedData', 'apiRequest', 'ensureApiKey', 'exportToCSV', 'importFromCSV',
        'getExpiryStatus', 'getDaysLeft', 'updateProductList', 'updateReminder'
    ];

    expected.forEach(function (name) {
        assert.equal(typeof context[name], 'function', 'window.' + name + ' 应该是函数');
    });
});

test('删除的旧代码不会留下引用（同步不再直连仓库 / 数据库）', () => {
    // 只看代码，不看注释：注释里提到旧名字是有意义的说明，不算引用
    const script = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

    const removed = [
        'ghToken', 'ghLoad', 'ghSave', 'ghHeaders', 'ensureGhToken',
        'cbDb', 'cbApp', 'initCloudBase', 'upsertCollection', 'fetchAllFromCloud',
        'IS_GITHUB_PAGES', 'startRealtimeWatch', 'cloudDocToProduct',
        'encodeBase64Utf8', 'cloudbase'
    ];

    removed.forEach(function (name) {
        const hit = new RegExp('\\b' + name + '\\b').test(script);
        assert.equal(hit, false, 'script.js 里不该再出现 ' + name);
    });

    // 页面里不该再有任何令牌类的东西
    assert.equal(/ghp_[A-Za-z0-9]/.test(script), false, 'script.js 里不该有 GitHub 令牌');
});

test('临期阈值只有一个来源：页面从接口取，不在页面里写死 30', () => {
    const script = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf-8');

    assert.match(script, /remindDays/, '页面应该有 remindDays 变量');
    assert.match(script, /getExpiryStatusFor\(validity,\s*remindDays\)/,
        '状态判断应该把 remindDays 传进去，而不是写死 30');

    // 云函数侧的默认值也应来自共享模块
    const notify = fs.readFileSync(path.join(ROOT, 'cloudfunctions/expire-notify/index.js'), 'utf-8');
    assert.match(notify, /dates\.DEFAULT_REMIND_DAYS/, '提醒函数应该用共享模块的默认阈值');
});

test('页面加载时会读一次本机缓存并渲染（初始化流程不依赖网络）', () => {
    const context = makeSandbox();

    loadInto(context, 'shared/dates.js');
    loadInto(context, 'shared/merge.js');
    loadInto(context, 'shared/csv.js');
    loadInto(context, 'script.js');

    // 触发 DOMContentLoaded：把本机缓存的商品读进来，不应抛异常
    assert.equal(typeof context.listeners.DOMContentLoaded, 'function', '应该注册了 DOMContentLoaded');

    context.localStorage.setItem('products', JSON.stringify([
        { uid: 'u1', barcode: '690', productName: '牛奶', validity: '2026-09-20' }
    ]));

    context.listeners.DOMContentLoaded();
    // products 是 script.js 里的顶层 let，不会成为全局属性，所以用表达式取值
    const count = vm.runInContext('products.length', context);
    assert.equal(count, 1, '缓存里的商品应该被读进内存');
});
