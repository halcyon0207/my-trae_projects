'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dates = require('../shared/dates.js');

// 固定一个「今天」，测试才不会随运行日期变化
const TODAY = new Date(2026, 8, 14);      // 2026-09-14（月份从 0 开始）

test('parseDateLocal 按本地时区解析，不偏一天', () => {
    const d = dates.parseDateLocal('2026-09-14');
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 8);
    assert.equal(d.getDate(), 14);
    assert.equal(d.getHours(), 0);
});

test('parseDateLocal 对空值 / 垃圾输入返回 null', () => {
    assert.equal(dates.parseDateLocal(''), null);
    assert.equal(dates.parseDateLocal(null), null);
    assert.equal(dates.parseDateLocal('不是一个日期'), null);
});

test('formatDateLocal 与 parseDateLocal 往返一致', () => {
    assert.equal(dates.formatDateLocal(dates.parseDateLocal('2026-09-14')), '2026-09-14');
    assert.equal(dates.todayLocal(TODAY), '2026-09-14');
});

test('addMonthsClamped 处理月末溢出（1月31日 + 1个月）', () => {
    const jan31 = new Date(2026, 0, 31);
    assert.equal(dates.formatDateLocal(dates.addMonthsClamped(jan31, 1)), '2026-02-28');

    const jan31Leap = new Date(2028, 0, 31);   // 2028 是闰年
    assert.equal(dates.formatDateLocal(dates.addMonthsClamped(jan31Leap, 1)), '2028-02-29');
});

test('daysLeft：今天到期是 0，昨天到期是 -1', () => {
    assert.equal(dates.daysLeft('2026-09-14', TODAY), 0);
    assert.equal(dates.daysLeft('2026-09-13', TODAY), -1);
    assert.equal(dates.daysLeft('2026-09-24', TODAY), 10);
    assert.equal(dates.daysLeft('', TODAY), null);
});

test('getExpiryStatusFor 的阈值只由 remindDays 决定', () => {
    // 默认窗口 30 天
    assert.equal(dates.getExpiryStatusFor('2026-09-13', 30, TODAY), 'expired');
    assert.equal(dates.getExpiryStatusFor('2026-09-14', 30, TODAY), 'danger');   // 今天到期算临期
    assert.equal(dates.getExpiryStatusFor('2026-10-14', 30, TODAY), 'danger');   // 刚好 30 天
    assert.equal(dates.getExpiryStatusFor('2026-10-15', 30, TODAY), 'warning');  // 31 天
    assert.equal(dates.getExpiryStatusFor('2026-12-13', 30, TODAY), 'warning');  // 90 天
    assert.equal(dates.getExpiryStatusFor('2026-12-14', 30, TODAY), 'normal');   // 91 天
    assert.equal(dates.getExpiryStatusFor('', 30, TODAY), 'unknown');

    // 换个窗口，边界跟着走
    assert.equal(dates.getExpiryStatusFor('2026-09-21', 7, TODAY), 'danger');    // 7 天内
    assert.equal(dates.getExpiryStatusFor('2026-09-22', 7, TODAY), 'warning');   // 8 天
});

test('getStatusLabel 直接说人话', () => {
    assert.equal(dates.getStatusLabel('2026-09-14', TODAY), '今天到期');
    assert.equal(dates.getStatusLabel('2026-09-13', TODAY), '过期1天');
    assert.equal(dates.getStatusLabel('2026-09-20', TODAY), '剩6天');
    assert.equal(dates.getStatusLabel('', TODAY), '未填有效期');
});

test('formatShelfLife 兼容没有单位的旧数据', () => {
    assert.equal(dates.formatShelfLife({ shelfLife: '12', shelfLifeUnit: '月' }), '12个月');
    assert.equal(dates.formatShelfLife({ shelfLife: '7', shelfLifeUnit: '天' }), '7天');
    assert.equal(dates.formatShelfLife({ shelfLife: '12' }), '12个月');
    assert.equal(dates.formatShelfLife({}), '-');
});

test('classifyForReminder 分三档，且跳过已处理 / 已删除 / 无有效期', () => {
    const products = [
        { barcode: '1', productName: '过期奶', validity: '2026-09-10' },
        { barcode: '2', productName: '今天到期', validity: '2026-09-14' },
        { barcode: '3', productName: '临期7天', validity: '2026-09-20' },
        { barcode: '4', productName: '临期30天', validity: '2026-10-14' },
        { barcode: '5', productName: '还早', validity: '2026-12-31' },
        { barcode: '6', productName: '没填', validity: '' },
        { barcode: '7', productName: '已处理', validity: '2026-09-01', handledAt: '2026-09-05' },
        { barcode: '8', productName: '已删除', validity: '2026-09-02', deletedAt: '2026-09-05' }
    ];

    const r = dates.classifyForReminder(products, { remindDays: 30, now: TODAY });

    assert.deepEqual(r.overdue.map((x) => x.name), ['过期奶']);
    assert.deepEqual(r.dueToday.map((x) => x.name), ['今天到期']);
    // 按剩余天数升序，越急越靠前
    assert.deepEqual(r.soon.map((x) => x.name), ['临期7天', '临期30天']);

    // 窗口收窄到 7 天，“临期30天”那条就不再进提醒
    const narrow = dates.classifyForReminder(products, { remindDays: 7, now: TODAY });
    assert.deepEqual(narrow.soon.map((x) => x.name), ['临期7天']);
});

test('classifyForReminder 接受空数据', () => {
    const r = dates.classifyForReminder(null, { now: TODAY });
    assert.deepEqual(r, { overdue: [], dueToday: [], soon: [] });
});
