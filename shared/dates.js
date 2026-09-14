/*
 * 日期与到期状态（共享模块）
 *
 * 这个文件同时被三方使用：
 *   1. 浏览器（index.html 里用 <script> 引入，挂到 window.ExpiryShared.dates）
 *   2. 云函数（部署脚本会把它复制到各函数的 lib/ 目录，用 require 引入）
 *   3. 单元测试（tests/dates.test.js 直接 require）
 * 所以外面套了一层 UMD 壳，改这里等于三处同时生效，不要在任何一方另抄一份。
 *
 * 全部按「本地日历日」计算：容器/浏览器时区是 Asia/Shanghai 时就是北京时间。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else {
        root.ExpiryShared = root.ExpiryShared || {};
        root.ExpiryShared.dates = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const DAY_MS = 86400000;
    const DEFAULT_REMIND_DAYS = 30;   // 临期窗口（天）：一个月内开始提醒

    // 把 'YYYY-MM-DD' 解析成「本地时区」的当天 0 点。
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

    function todayLocal(now) {
        return formatDateLocal(now || new Date());
    }

    // 加 N 个月。1月31日 + 1个月会滚到 3 月，这里收敛到当月最后一天
    function addMonthsClamped(date, months) {
        const day = date.getDate();
        const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
        const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
        target.setDate(Math.min(day, lastDay));
        return target;
    }

    // 距离到期还有多少天（按本地日历日算：今天到期是 0，昨天到期是 -1）
    // 返回 null 表示这条记录没有可用的有效期
    function daysLeft(validity, now) {
        const expiry = parseDateLocal(validity);
        if (!expiry) return null;

        const current = now || new Date();
        const today = new Date(current.getFullYear(), current.getMonth(), current.getDate());
        return Math.round((expiry - today) / DAY_MS);
    }

    // 到期状态。阈值只有一个来源：remindDays（默认 30）
    //   unknown 没填有效期（不能当成「正常」） / expired 已过期 / danger 临期 / warning 1-3个月 / normal 正常
    function getExpiryStatusFor(validity, remindDays, now) {
        const days = daysLeft(validity, now);
        if (days === null) return 'unknown';
        if (days < 0) return 'expired';

        const window = Number(remindDays) > 0 ? Number(remindDays) : DEFAULT_REMIND_DAYS;
        if (days <= window) return 'danger';
        if (days <= 90) return 'warning';
        return 'normal';
    }

    const STATUS_TEXT = {
        normal: '正常',
        warning: '1-3个月',
        danger: '1个月内',
        expired: '已过期',
        unknown: '无有效期'
    };

    function getStatusText(status) {
        return STATUS_TEXT[status] || status;
    }

    // 列表状态列用的短标签：直接写“还剩几天”，比“1个月内”更直观
    function getStatusLabel(validity, now) {
        const days = daysLeft(validity, now);
        if (days === null) return '未填有效期';
        if (days < 0) return '过期' + Math.abs(days) + '天';
        if (days === 0) return '今天到期';
        return '剩' + days + '天';
    }

    // 保质期显示，例如“12个月”“7天”；旧数据没有单位时按“月”处理
    function formatShelfLife(product) {
        if (!product || !product.shelfLife) return '-';
        const unit = product.shelfLifeUnit || '月';
        return product.shelfLife + (unit === '月' ? '个月' : unit);
    }

    // 把记录分成「已过期 / 今天到期 / 临期」三档，并带上剩余天数。
    // 已处理的（handledAt）和已删除的（deletedAt）不参与提醒。
    function classifyForReminder(products, options) {
        const opts = options || {};
        const remindDays = Number(opts.remindDays) > 0 ? Number(opts.remindDays) : DEFAULT_REMIND_DAYS;
        const now = opts.now || new Date();

        const overdue = [];      // 已过期（含更早）
        const dueToday = [];     // 今天到期
        const soon = [];         // 1 ~ remindDays 天内

        (products || []).forEach(function (product) {
            if (!product || product.deletedAt || product.handledAt) return;

            const days = daysLeft(product.validity, now);
            if (days === null) return;

            const item = {
                name: product.productName || product.barcode || '(未命名)',
                validity: product.validity || '',
                days: days
            };

            if (days < 0) overdue.push(item);
            else if (days === 0) dueToday.push(item);
            else if (days <= remindDays) soon.push(item);
        });

        const byDays = function (a, b) { return a.days - b.days; };
        overdue.sort(byDays);
        dueToday.sort(byDays);
        soon.sort(byDays);

        return { overdue: overdue, dueToday: dueToday, soon: soon };
    }

    return {
        DAY_MS: DAY_MS,
        DEFAULT_REMIND_DAYS: DEFAULT_REMIND_DAYS,
        parseDateLocal: parseDateLocal,
        formatDateLocal: formatDateLocal,
        todayLocal: todayLocal,
        addMonthsClamped: addMonthsClamped,
        daysLeft: daysLeft,
        getExpiryStatusFor: getExpiryStatusFor,
        getStatusText: getStatusText,
        getStatusLabel: getStatusLabel,
        formatShelfLife: formatShelfLife,
        classifyForReminder: classifyForReminder
    };
});
