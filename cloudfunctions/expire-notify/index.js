'use strict';

// 商品到期提醒：每天扫一遍仓库里的 data.json，把过期 / 临期商品通过 PushPlus 推送到微信。
//
// 推送节奏（不是每天都推，避免「天天收到请放心」最后被无视）：
//   · 已过期（含今天到期）→ 每天都推，这是真该处理的
//   · 只是临期（1 ~ REMIND_DAYS 天）→ 每周一汇总推一次
//   · 完全没内容 → 按 PUSH_WHEN_EMPTY：weekly（默认，周一推「请放心」）/ daily / never
//   · 运行失败 → 立刻推一条明确写着「运行失败」的消息
//     （否则「出错」和「当天没事」在微信里长得一模一样，你会一直以为一切正常）
//
// 环境变量（值放在项目根目录 .env.local）：
//   PUSHPLUS_TOKEN   必填，pushplus.plus 注册并实名后获取
//   GITHUB_TOKEN     必填，读私有仓库 product-expiry 用
//   TZ               必填 Asia/Shanghai —— SCF 运行环境默认 UTC，
//                    而定时器按北京时间 7:30 触发（= UTC 前一天 23:30）。
//                    不设 TZ 的话云端认的「今天」是前一天，日期和剩余天数整体差一天。
//   REMIND_DAYS      可选，临期窗口天数，默认 30（与 product-api 保持一致）
//   PUSH_WHEN_EMPTY  可选，daily | weekly | never，默认 weekly

const https = require('https');
const dates = require('./lib/dates.js');

const GH_OWNER = process.env.GITHUB_OWNER || 'halcyon0207';
const GH_REPO = process.env.GITHUB_REPO || 'product-expiry';
const GH_FILE = process.env.GITHUB_FILE || 'data.json';
const GH_REF = process.env.GITHUB_REF || 'main';

exports.main = async (event) => {
    const token = (process.env.PUSHPLUS_TOKEN || '').trim();
    if (!token) {
        return { code: 400, message: '未配置 PUSHPLUS_TOKEN 环境变量' };
    }

    const force = !!(event && event.force);   // 手动验证时用：忽略「今天该不该推」

    try {
        const raw = await fetchDataJson();
        if (raw === null) {
            // 仓库里还没有 data.json —— 多半是从没点过「同步数据」
            await pushPlusSend(
                token,
                '【到期提醒】数据还没同步到云端',
                '打开「商品到期提醒」页面，点一次「同步数据」把数据存到云端，'
                + '之后才会每天自动提醒。\n\n' + sign()
            );
            return { code: 0, scanned: 0, hint: 'data.json 不存在' };
        }

        const data = parseDataJson(raw);
        const products = data.products || [];
        const groups = dates.classifyForReminder(products, { remindDays: remindDays() });

        const urgentCount = groups.overdue.length + groups.dueToday.length;
        const soonCount = groups.soon.length;
        const isMonday = new Date().getDay() === 1;
        const emptyMode = (process.env.PUSH_WHEN_EMPTY || 'weekly').trim().toLowerCase();

        const scanned = products.filter(function (p) {
            return p && !p.deletedAt && !p.handledAt;
        }).length;

        // 决定今天推不推
        let reason;
        if (urgentCount > 0) reason = 'urgent';
        else if (soonCount > 0) reason = isMonday || force ? 'weekly' : 'skip';
        else if (emptyMode === 'never') reason = 'skip';
        else if (emptyMode === 'daily' || force) reason = 'empty';
        else reason = isMonday ? 'empty' : 'skip';

        if (reason === 'skip') {
            return {
                code: 0, scanned: scanned, pushed: false,
                counts: countPayload(groups),
                hint: '今天不用推：仅临期商品按周一汇总，无内容按 ' + emptyMode
            };
        }

        // 「紧急」但今天不是周一：只列已过期/今天到期，临期只给一句统计，
        // 免得每天都是一份长清单，反而没人看
        const weekly = reason === 'weekly' || isMonday || force;
        const title = buildTitle(groups, weekly);
        const content = buildContent(groups, weekly);

        const result = await pushPlusSend(token, title, content);

        return {
            code: 0,
            scanned: scanned,
            pushed: true,
            reason: reason,
            counts: countPayload(groups),
            pushplus: result
        };
    } catch (err) {
        console.error('expire-notify 运行失败:', err);
        const message = (err && err.message) || String(err);

        // 失败也要让你知道 —— 静默失败等于「你以为一切正常」
        let notify = null;
        try {
            notify = await pushPlusSend(
                token,
                '【到期提醒】运行失败',
                '今天没能检查商品有效期，请确认原因：\n\n' + message +
                '\n\n常见原因：GitHub 令牌失效 / 仓库改名 / 网络异常。\n\n' + sign()
            );
        } catch (pushErr) {
            console.error('失败告警也发不出去:', pushErr);
        }

        return { code: 500, error: message, alertSent: !!(notify && notify.status === 200) };
    }
};

function remindDays() {
    const value = Number(process.env.REMIND_DAYS);
    return value > 0 ? value : dates.DEFAULT_REMIND_DAYS;
}

function countPayload(groups) {
    return {
        expired: groups.overdue.length,
        dueToday: groups.dueToday.length,
        soon: groups.soon.length
    };
}

function buildTitle(groups, weekly) {
    const expired = groups.overdue.length;
    const today = groups.dueToday.length;
    const soon = groups.soon.length;

    if (expired === 0 && today === 0 && soon === 0) return '【到期提醒】今日无临期商品';

    const parts = [];
    if (expired) parts.push(expired + ' 件已过期');
    if (today) parts.push(today + ' 件今天到期');
    if (weekly && soon) parts.push(soon + ' 件 ' + remindDays() + ' 天内到期');

    return '【到期提醒】' + (weekly ? '本周汇总：' : '') + parts.join('、');
}

function buildContent(groups, weekly) {
    const lines = [];

    if (groups.overdue.length) {
        lines.push('【已过期】');
        groups.overdue.forEach(function (item) {
            lines.push('· ' + item.name + '（到期 ' + item.validity + '，已过 ' + (-item.days) + ' 天）');
        });
    }

    if (groups.dueToday.length) {
        if (lines.length) lines.push('');
        lines.push('【今天到期】');
        groups.dueToday.forEach(function (item) {
            lines.push('· ' + item.name + '（到期 ' + item.validity + '，今天最后一天）');
        });
    }

    if (weekly && groups.soon.length) {
        if (lines.length) lines.push('');
        lines.push('【' + remindDays() + ' 天内到期】');
        groups.soon.forEach(function (item) {
            lines.push('· ' + item.name + '（到期 ' + item.validity + '，还剩 ' + item.days + ' 天）');
        });
    } else if (groups.soon.length) {
        // 非周一：只给一句统计，完整清单留到周一汇总
        if (lines.length) lines.push('');
        lines.push('另有 ' + groups.soon.length + ' 件在 ' + remindDays() + ' 天内到期，周一汇总提醒。');
    }

    if (lines.length === 0) {
        lines.push('今天没有临期或过期商品，请放心');
    }

    lines.push('');
    lines.push(sign());
    return lines.join('\n');
}

function sign() {
    return '—— 「商品到期提醒」自动发送（' + dates.todayLocal() + '）';
}

/* ---------------- GitHub 读取 ---------------- */

// GET GitHub contents API；返回文件原始文本；文件不存在返回 null
function fetchDataJson() {
    return new Promise((resolve, reject) => {
        const path = '/repos/' + GH_OWNER + '/' + GH_REPO + '/contents/' + GH_FILE + '?ref=' + GH_REF;
        const token = (process.env.GITHUB_TOKEN || '').trim();
        const headers = {
            'User-Agent': 'expire-notify-cloud-function',
            'Accept': 'application/vnd.github.v3+json'
        };
        // 私有仓库必须带 PAT；公开仓库可省略
        if (token) headers['Authorization'] = 'Bearer ' + token;

        const req = https.request({
            hostname: 'api.github.com',
            path: path,
            method: 'GET',
            headers: headers
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
                    resolve(Buffer.from(obj.content || '', 'base64').toString('utf-8'));
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

/* ---------------- PushPlus ---------------- */

function pushPlusSend(token, title, content) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            token: token,
            title: title,
            content: content,
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
                let parsed;
                try { parsed = JSON.parse(text); }
                catch (e) { parsed = text; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
