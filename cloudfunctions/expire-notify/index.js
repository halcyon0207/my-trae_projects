'use strict';

// 商品到期提醒：每天扫一遍 GitHub 仓库的 data.json，把过期 / 30 天内到期的
// 通过 PushPlus 推送到微信。部署到 CloudBase 后由定时触发器每天早上 9 点调用。
// 需配置环境变量 PUSHPLUS_TOKEN（pushplus.plus 注册并实名后获取）

const https = require('https');

// 与前端默认数据源保持一致：仓库 halcyon0207/my-trae_projects/data.json
const GH_OWNER = 'halcyon0207';
const GH_REPO  = 'my-trae_projects';
const GH_FILE  = 'data.json';
const GH_REF   = 'main';

const DAY_MS = 86400000;
const REMIND_DAYS = 30;

exports.main = async () => {
    const token = (process.env.PUSHPLUS_TOKEN || '').trim();
    if (!token) {
        return { code: 400, message: '未配置 PUSHPLUS_TOKEN 环境变量' };
    }

    try {
        const raw = await fetchGithubDataJson();
        if (raw === null) {
            // 仓库里还没有 data.json —— 多半是用户从没点过「同步到云端」
            await pushPlusSend(
                token,
                '【到期提醒】数据还没同步到云端',
                '打开「商品到期提醒」页面，点一次「同步到云端」并选 GitHub，'
                + '之后每天早上 9:00 才会自动推送。'
                + '\n\n—— 「商品到期提醒」自动发送（' + formatToday() + '）'
            );
            return { code: 0, scanned: 0, hint: 'data.json 不存在' };
        }

        const data = parseDataJson(raw);
        const products = (data.products || []).filter((p) => !p.handledAt && !p.deletedAt);

        const { expired, soon } = classify(products);
        const title = buildTitle(expired, soon);
        const content = buildContent(expired, soon);
        const result = await pushPlusSend(token, title, content);

        return {
            code: 0,
            scanned: products.length,
            counts: { expired: expired.length, soon: soon.length },
            pushplus: result
        };
    } catch (err) {
        console.error('expire-notify 运行失败:', err);
        return {
            code: 500,
            error: (err && err.message) || String(err)
        };
    }
};

// GET GitHub contents API；返回文件原始文本；文件不存在返回 null
function fetchGithubDataJson() {
    return new Promise((resolve, reject) => {
        const path = '/repos/' + GH_OWNER + '/' + GH_REPO + '/contents/' + GH_FILE + '?ref=' + GH_REF;
        const req = https.request({
            hostname: 'api.github.com',
            path,
            method: 'GET',
            headers: {
                'User-Agent': 'expire-notify-cloud-function',
                'Accept': 'application/vnd.github.v3+json'
            }
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf-8');
                if (res.statusCode === 404) return resolve(null);
                if (res.statusCode !== 200) {
                    return reject(new Error('GitHub API ' + res.statusCode + ': ' + text.slice(0, 200)));
                }
                try {
                    const obj = JSON.parse(text);
                    const content = Buffer.from(obj.content || '', 'base64').toString('utf-8');
                    resolve(content);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function parseDataJson(text) {
    // data.json 里可能夹着墓碑（deletedAt）和活记录；都按商品对象解析
    try { return JSON.parse(text); }
    catch (e) { return { products: [] }; }
}

function classify(products) {
    const expired = [];
    const soon = [];
    for (const p of products) {
        const days = daysLeft(p.validity);
        if (days === null) continue;
        const item = {
            name: p.productName || p.barcode || '(未命名)',
            validity: p.validity || '',
            days
        };
        if (days < 0) expired.push(item);
        else if (days <= REMIND_DAYS) soon.push(item);
    }
    expired.sort((a, b) => a.days - b.days);
    soon.sort((a, b) => a.days - b.days);
    return { expired, soon };
}

function daysLeft(validity) {
    const expiry = parseDateLocal(validity);
    if (!expiry) return null;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((expiry - today) / DAY_MS);
}

function parseDateLocal(value) {
    if (!value) return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    if (typeof value !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
}

function buildTitle(expired, soon) {
    const total = expired.length + soon.length;
    if (total === 0) return '【到期提醒】今日无临期商品';
    return `【到期提醒】${expired.length} 件过期、${soon.length} 件 30 天内到期`;
}

function buildContent(expired, soon) {
    const lines = [];
    if (expired.length) {
        lines.push('【已过期】');
        for (const it of expired) {
            lines.push(`· ${it.name}（到期 ${it.validity}，已过 ${-it.days} 天）`);
        }
    }
    if (soon.length) {
        if (expired.length) lines.push('');
        lines.push(`【临期 30 天内】`);
        for (const it of soon) {
            lines.push(`· ${it.name}（到期 ${it.validity}，还剩 ${it.days} 天）`);
        }
    }
    if (expired.length === 0 && soon.length === 0) {
        lines.push('今天没有临期或过期商品，请放心。');
    }
    lines.push('');
    lines.push(`—— 「商品到期提醒」自动发送（${formatToday()}）`);
    return lines.join('\n');
}

function formatToday() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function pushPlusSend(token, title, content) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            token,
            title,
            content,
            template: 'txt'
        });
        const req = https.request({
            hostname: 'www.pushplus.plus',
            path: '/send',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(body)
            }
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf-8');
                let body;
                try { body = JSON.parse(text); }
                catch (e) { body = text; }
                resolve({ status: res.statusCode, body });
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}