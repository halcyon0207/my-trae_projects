'use strict';

/*
 * 接口冒烟测试（只读）：按前端 script.js 的调用方式打真实接口，
 * 检查返回的字段确实是页面要用的那些，防止「页面改了、接口没跟上」这类对不上的问题。
 *
 * 用法：node scripts/api-smoke.js
 * 只做 hello / pull，不写入云端 —— 数据是你在用的真实数据，不能被测试污染。
 */

const fs = require('fs');
const path = require('path');

const API_BASE = process.env.API_BASE ||
    'https://trae-projects-4g5aob6ufac38569-1421597865.ap-shanghai.app.tcloudbase.com/api';

function loadEnvLocal() {
    const file = path.join(__dirname, '..', '.env.local');
    const env = {};
    if (!fs.existsSync(file)) return env;

    fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '').split(/\r?\n/).forEach(function (line) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m) env[m[1]] = m[2];
    });
    return env;
}

const env = loadEnvLocal();
const apiKey = process.env.API_KEY || env.API_KEY;
if (!apiKey) {
    console.error('缺少 API_KEY：请确认 .env.local 里有，或用环境变量传入');
    process.exit(1);
}

async function call(action, extra) {
    const res = await fetch(API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({
            action: action,
            key: apiKey,
            products: [],
            mappings: [],
            tombstones: { products: [], mappings: [] }
        }, extra || {}))
    });
    const text = await res.text();
    return { status: res.status, json: JSON.parse(text) };
}

function assert(condition, message) {
    if (!condition) throw new Error('断言失败：' + message);
    console.log('  ✓ ' + message);
}

(async function run() {
    console.log('接口：' + API_BASE);

    console.log('\n[1] hello（校验口令 + 取配置）');
    const hello = await call('hello');
    assert(hello.status === 200 && hello.json.code === 0, 'hello 返回 200 / code 0');
    assert(typeof hello.json.data.config.remindDays === 'number', '下发了 remindDays（数字）');

    console.log('\n[2] 口令错误应被拒绝');
    const denied = await call('hello', { key: 'definitely-wrong' });
    assert(denied.status === 401, '错误口令返回 401');

    console.log('\n[3] pull（与空的本机数据合并）');
    const pull = await call('pull');
    assert(pull.status === 200 && pull.json.code === 0, 'pull 返回 200 / code 0');

    const data = pull.json.data;
    assert(Array.isArray(data.products), 'data.products 是数组');
    assert(Array.isArray(data.mappings), 'data.mappings 是数组');
    assert(data.tombstones && Array.isArray(data.tombstones.products), 'data.tombstones.products 是数组');
    assert(Array.isArray(data.tombstones.mappings), 'data.tombstones.mappings 是数组');
    assert(data.config && typeof data.config.remindDays === 'number', 'data.config.remindDays 存在');

    const stats = pull.json.stats;
    assert(typeof stats.remoteLive === 'number', 'stats.remoteLive 存在（页面用它判断有没有未上传改动）');
    assert(typeof stats.remoteTombstones === 'number', 'stats.remoteTombstones 存在');

    // 活记录里不能再混着墓碑：混了页面列表会把这些当成商品显示出来
    const liveHasTombstone = data.products.some(function (p) { return p && p.deletedAt; });
    assert(!liveHasTombstone, 'data.products 里不含墓碑（deletedAt）');

    console.log('\n结果：商品 ' + data.products.length + ' 条 / 映射 ' + data.mappings.length + ' 条' +
                ' / 墓碑 ' + data.tombstones.products.length + ' 条');
    console.log('云端原有：活记录 ' + stats.remoteLive + ' 条 / 墓碑 ' + stats.remoteTombstones + ' 条');
    console.log('\n全部通过。');
})().catch(function (error) {
    console.error('\n失败：' + (error.message || error));
    process.exit(1);
});
