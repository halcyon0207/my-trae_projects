'use strict';

// 商品到期提醒：每天扫一遍 products 表，把过期 / 30 天内到期的通过 PushPlus 推到微信
// 部署到 CloudBase 后由定时触发器每天早上 9 点调用
// 需配置环境变量 PUSHPLUS_TOKEN（pushplus.plus 注册并实名后获取）

const cloudbase = require('@cloudbase/node-sdk');
const https = require('https');

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const db = app.database();

const DAY_MS = 86400000;
const REMIND_DAYS = 30;

exports.main = async () => {
    const token = (process.env.PUSHPLUS_TOKEN || '').trim();
    if (!token) {
        return { code: 400, message: '未配置 PUSHPLUS_TOKEN 环境变量' };
    }

    try {
        const products = await fetchProducts();
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

// 拉商品表全部记录；limit 1000 防极端情况，已处理过滤在内存里做（避免依赖文档里有无 handledAt 字段的判断）
async function fetchProducts() {
    const res = await db.collection('products').where({}).limit(1000).get();
    const list = res.data || [];
    // 已处理（handledAt 有值）或已删除墓碑（deletedAt 有值）的跳过
    return list.filter((p) => !p.handledAt && !p.deletedAt);
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

// 兼容 "YYYY-MM-DD" / "YYYY-MM-DDTHH:mm:ss..." / Date
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