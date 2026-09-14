'use strict';

/*
 * product-api —— 数据读写代理（HTTP 访问服务）
 *
 * 为什么要有它：
 *   以前浏览器直接拿 GitHub 令牌读写仓库，等于把仓库钥匙放在浏览器里（localStorage），
 *   同一台电脑的别人、或任意 XSS 都能拿走。现在令牌只存在云端环境变量里，
 *   浏览器只跟这个函数说话，并且要带上访问口令（API_KEY）。
 *
 * 接口（POST，JSON；浏览器跨域访问，响应带 CORS 头）：
 *   { action: 'hello' }                        → 只校验口令，返回配置
 *   { action: 'pull',  key, products, mappings, tombstones }  → 与云端合并后返回结果，不写入
 *   { action: 'push',  key, products, mappings, tombstones }  → 合并 → 写回仓库 → 返回合并结果
 *
 * 合并在服务端做（shared/merge.js），所以：
 *   · 两台设备先后提交也不会互相覆盖（每次写之前都重读最新版本再合并）
 *   · 「同步」和「获取最新数据」先点哪个都不丢数据
 *
 * 环境变量：
 *   API_KEY       必填，访问口令（前端填一次，存本机）
 *   GITHUB_TOKEN  必填，读私有仓库 product-expiry 用
 *   GITHUB_REPO / GITHUB_OWNER / GITHUB_FILE / GITHUB_REF  可选，覆盖默认值
 *   REMIND_DAYS   可选，临期窗口天数，默认 30（前端从这里取，避免两边各写一个 30）
 */

const https = require('https');
const merge = require('./lib/merge.js');

const GH_OWNER = process.env.GITHUB_OWNER || 'halcyon0207';
const GH_REPO = process.env.GITHUB_REPO || 'product-expiry';
const GH_FILE = process.env.GITHUB_FILE || 'data.json';
const GH_REF = process.env.GITHUB_REF || 'main';

const DEFAULT_REMIND_DAYS = 30;
const MAX_WRITE_ATTEMPTS = 3;   // 版本冲突时重读重试的次数

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
    'Access-Control-Max-Age': '86400'
};

function respond(statusCode, payload) {
    return {
        statusCode: statusCode,
        headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS_HEADERS),
        body: JSON.stringify(payload)
    };
}

function remindDays() {
    const value = Number(process.env.REMIND_DAYS);
    return value > 0 ? value : DEFAULT_REMIND_DAYS;
}

function config() {
    return { remindDays: remindDays() };
}

exports.main = async (event) => {
    const ev = event || {};

    // 浏览器跨域的预检请求：直接放行，不带业务逻辑
    const method = (ev.httpMethod || ev.method || '').toUpperCase();
    if (method === 'OPTIONS') return respond(204, {});

    let payload;
    try {
        payload = parsePayload(ev);
    } catch (error) {
        return respond(400, {
            code: 400,
            message: '请求体不是合法 JSON',
            got: typeof ev.body + ':' + String(ev.body).slice(0, 120)
        });
    }

    const action = payload.action || 'hello';

    // 口令校验：HTTP 访问服务本身是公开的，这里就是唯一的一道门
    const expected = (process.env.API_KEY || '').trim();
    if (!expected) {
        return respond(500, { code: 500, message: '云函数未配置 API_KEY 环境变量' });
    }
    const provided = String(ev.headers?.['x-api-key'] || ev.headers?.['X-Api-Key'] || payload.key || '').trim();
    if (provided !== expected) {
        return respond(401, { code: 401, message: '访问口令不正确' });
    }

    try {
        if (action === 'hello') {
            return respond(200, { code: 0, data: { config: config() } });
        }

        if (action !== 'pull' && action !== 'push') {
            return respond(400, { code: 400, message: '未知的 action：' + action });
        }

        const local = normalizeLocal(payload);
        const preferLocal = action === 'push';

        // push 在写回前会遇到别的设备刚写过（sha 失效），所以放在循环里重试
        let attempt = 0;
        while (true) {
            attempt++;
            const remote = await readDataFile();

            const mergedProducts = merge.mergeProducts(
                remote.products, local.products, local.tombstones.products, preferLocal);
            const mergedMappings = merge.mergeMappings(
                remote.mappings, local.mappings, local.tombstones.mappings, preferLocal);

            const result = {
                products: mergedProducts.products,
                mappings: mergedMappings.mappings,
                tombstones: {
                    products: mergedProducts.tombstones,
                    mappings: mergedMappings.tombstones
                }
            };

            if (action === 'pull') {
                // 拉取只返回合并结果，不动云端：于是「获取最新数据」也不会抹掉本机新改的记录
                return respond(200, {
                    code: 0,
                    data: Object.assign({ config: config() }, result),
                    stats: buildStats(remote, result)
                });
            }

            const wrote = await writeDataFile(result, remote.sha, attempt);
            if (wrote.ok) {
                return respond(200, {
                    code: 0,
                    data: Object.assign({ config: config(), rev: wrote.sha }, result),
                    stats: buildStats(remote, result)
                });
            }
            if (!wrote.conflict || attempt >= MAX_WRITE_ATTEMPTS) {
                return respond(500, {
                    code: 500,
                    message: wrote.message || '写入仓库失败'
                });
            }
            // 版本冲突：下一轮重新读取最新版本再合并（本机数据一条都不会丢）
        }
    } catch (error) {
        console.error('product-api 执行失败:', error);
        return respond(500, { code: 500, message: (error && error.message) || String(error) });
    }
};

// 兼容多种调用方式，别想当然：
//   · HTTP 访问服务有时给字符串，有时网关已经把 JSON 解析成对象了
//   · 带 isBase64Encoded 的要先解码
//   · 直接用 tcb fn invoke 调试时，event 本身就是载荷
function parsePayload(event) {
    const body = event.body;

    if (body === undefined || body === null || body === '') {
        return event.action ? event : {};
    }
    if (typeof body === 'object') return body;   // 网关已解析

    let raw = event.isBase64Encoded
        ? Buffer.from(String(body), 'base64').toString('utf-8')
        : String(body);

    raw = raw.replace(/^\uFEFF/, '');   // 有些客户端会带 BOM，JSON.parse 会直接报错

    return raw ? JSON.parse(raw) : {};
}

function normalizeLocal(payload) {
    const tombstones = payload.tombstones || {};
    return {
        products: Array.isArray(payload.products) ? payload.products : [],
        mappings: Array.isArray(payload.mappings) ? payload.mappings : [],
        tombstones: {
            products: Array.isArray(tombstones.products) ? tombstones.products : [],
            mappings: Array.isArray(tombstones.mappings) ? tombstones.mappings : []
        }
    };
}

function buildStats(remote, result) {
    // 云端那份是「活记录 + 墓碑」混在一起存的，这里拆开计数，
    // 前端拿它判断「本机有没有还没上传的改动」
    const remoteLive = remote.products.filter(function (record) {
        return !merge.isTombstone(record);
    }).length;

    return {
        remoteProducts: remote.products.length,
        remoteLive: remoteLive,
        remoteTombstones: remote.products.length - remoteLive,
        remoteMappings: remote.mappings.length,
        products: result.products.length,
        mappings: result.mappings.length,
        deletedProducts: result.tombstones.products.length,
        deletedMappings: result.tombstones.mappings.length
    };
}

/* ---------------- GitHub 读写 ---------------- */

function githubRequest(options, body) {
    return new Promise((resolve, reject) => {
        const token = (process.env.GITHUB_TOKEN || '').trim();

        // 默认头 + 调用方自定义头。注意顺序：headers 必须在最后，
        // 否则自定义头会把 User-Agent / 鉴权一起覆盖掉（GitHub 会直接 403）
        const headers = Object.assign({
            'User-Agent': 'product-api-cloud-function',
            'Accept': 'application/vnd.github.v3+json'
        }, options.headers || {});
        // 私有仓库必须带 PAT；公开仓库可省略
        if (token) headers['Authorization'] = 'Bearer ' + token;

        const req = https.request(Object.assign({}, options, { headers: headers }), (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf-8');
                let json = null;
                try { json = JSON.parse(text); } catch (e) { /* 非 JSON 响应，保持 null */ }
                resolve({ statusCode: res.statusCode, text: text, json: json });
            });
        });

        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function fileUrl(query) {
    return '/repos/' + GH_OWNER + '/' + GH_REPO + '/contents/' + GH_FILE +
           (query ? '?' + query : '');
}

// 读取 data.json；文件还不存在时返回空数据（首次使用不该报错）
async function readDataFile() {
    const res = await githubRequest({
        hostname: 'api.github.com',
        path: fileUrl('ref=' + GH_REF),
        method: 'GET'
    });

    if (res.statusCode === 404) return { products: [], mappings: [], sha: null };
    if (res.statusCode !== 200) {
        throw new Error('读取仓库失败（HTTP ' + res.statusCode + '）：' +
                        (res.json && res.json.message ? res.json.message : res.text.slice(0, 120)));
    }

    let parsed = {};
    try {
        parsed = JSON.parse(Buffer.from((res.json && res.json.content) || '', 'base64').toString('utf-8'));
    } catch (e) {
        parsed = {};   // 文件被手改坏了也不至于让同步彻底不可用，按空数据继续
    }

    return {
        products: Array.isArray(parsed.products) ? parsed.products : [],
        mappings: Array.isArray(parsed.mappings) ? parsed.mappings : [],
        sha: (res.json && res.json.sha) || null
    };
}

// 写回 data.json。墓碑和活记录一起写（墓碑就是带 deletedAt 的记录），不另开存储
async function writeDataFile(result, sha, attempt) {
    const payload = JSON.stringify({
        products: result.products.concat(result.tombstones.products),
        mappings: result.mappings.concat(result.tombstones.mappings),
        updatedAt: new Date().toISOString(),
        updatedBy: 'product-api'
    }, null, 2);

    const body = JSON.stringify({
        message: '同步数据 ' + new Date().toISOString().slice(0, 16).replace('T', ' ') +
                 (attempt > 1 ? '（第 ' + attempt + ' 次尝试）' : ''),
        content: Buffer.from(payload, 'utf-8').toString('base64'),
        sha: sha || undefined
    });

    const res = await githubRequest({
        hostname: 'api.github.com',
        path: fileUrl(''),
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
        }
    }, body);

    if (res.statusCode === 409 || res.statusCode === 422) {
        // 422 也常见于 sha 过期（GitHub 两种情况都用）
        return { ok: false, conflict: true, message: '云端版本已变化' };
    }
    if (res.statusCode !== 200 && res.statusCode !== 201) {
        return {
            ok: false,
            conflict: false,
            message: '写入仓库失败（HTTP ' + res.statusCode + '）：' +
                     (res.json && res.json.message ? res.json.message : res.text.slice(0, 120))
        };
    }

    return { ok: true, sha: (res.json && res.json.content && res.json.content.sha) || null };
}
