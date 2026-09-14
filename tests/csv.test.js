'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const csv = require('../shared/csv.js');
const dates = require('../shared/dates.js');

const NOW = new Date(2026, 8, 14);   // 2026-09-14

const deps = {
    makeUid: (() => { let n = 0; return () => 'uid-' + (++n); })(),
    todayLocal: () => dates.todayLocal(NOW),
    now: NOW
};

test('csvCell 转义逗号、引号与换行', () => {
    assert.equal(csv.csvCell('纯牛奶, 1L'), '"纯牛奶, 1L"');
    assert.equal(csv.csvCell('带"引号"的名字'), '"带""引号""的名字"');
    assert.equal(csv.csvCell('两行\n名字'), '"两行\n名字"');
    assert.equal(csv.csvCell(null), '""');
    assert.equal(csv.csvCell(undefined), '""');
});

test('导出 → 导入 往返之后数据不丢（包含逗号 / 引号 / 换行）', () => {
    const products = [
        {
            type: '商品', barcode: '6901234567890', productName: '纯牛奶, 1L "特惠"',
            scanDate: '2026-09-01', validity: '2026-09-20', productionDate: '2026-08-01',
            shelfLife: '12', shelfLifeUnit: '月', handledAction: '已用完',
            handledAt: '2026-09-10', handledNote: '第一行\n第二行'
        }
    ];
    const mappings = [{ barcode: '6901111111111', productName: '面包' }];

    const text = csv.buildCsvText(products, mappings, {
        getStatusText: dates.getStatusText,
        getExpiryStatus: (v) => dates.getExpiryStatusFor(v, 30, NOW),
        formatShelfLife: dates.formatShelfLife
    });

    const back = csv.csvRowsToRecords(csv.parseCsvText(text), deps);

    assert.equal(back.products.length, 1);
    assert.equal(back.products[0].productName, '纯牛奶, 1L "特惠"');
    assert.equal(back.products[0].handledNote, '第一行\n第二行');
    assert.equal(back.products[0].handledAction, '已用完');
    assert.equal(back.products[0].handledAt, '2026-09-10');
    assert.equal(back.products[0].shelfLife, '12');
    assert.equal(back.mappings.length, 1);
    assert.equal(back.mappings[0].productName, '面包');
});

test('导出的状态列用的是中文文案', () => {
    const text = csv.buildCsvText(
        [{ barcode: '1', productName: 'A', validity: '2026-09-01' }], [],
        {
            getStatusText: dates.getStatusText,
            getExpiryStatus: (v) => dates.getExpiryStatusFor(v, 30, NOW),
            formatShelfLife: dates.formatShelfLife
        }
    );
    assert.match(text, /已过期/);
    // 表头不加引号（与原实现一致，Excel 打开更干净），数据行才加引号
    assert.match(text, /^类型,商品条码,商品名称/);
});

test('能读旧版本导出的 8 列文件（没有处置三列）', () => {
    const legacy = [
        '类型,商品条码,商品名称,扫描日期,有效期,生产日期,保质期,状态',
        '"商品","6901234567890","牛奶","2026-09-01","2026-09-20","2026-08-01","12个月","1个月内"'
    ].join('\n');

    const back = csv.csvRowsToRecords(csv.parseCsvText(legacy), deps);

    assert.equal(back.products.length, 1);
    assert.equal(back.products[0].handledAction, '', '旧文件没有处置列，按未处理');
    assert.equal(back.products[0].handledAt, '');
});

test('只有处置方式、没有处置日期时补今天，否则会被当成未处理', () => {
    const text = [
        '类型,商品条码,商品名称,扫描日期,有效期,生产日期,保质期,状态,处置方式,处置日期,处置备注',
        '"商品","6901234567890","牛奶","2026-09-01","2026-09-20","2026-08-01","12个月","1个月内","已丢弃","","长毛了"'
    ].join('\n');

    const back = csv.csvRowsToRecords(csv.parseCsvText(text), deps);
    assert.equal(back.products[0].handledAt, '2026-09-14');
    assert.equal(back.products[0].handledNote, '长毛了');
});

test('parseShelfLifeText 把各种写法归一到 数量 + 单位', () => {
    assert.deepEqual(csv.parseShelfLifeText('12个月'), { shelfLife: '12', shelfLifeUnit: '月' });
    assert.deepEqual(csv.parseShelfLifeText('7天'), { shelfLife: '7', shelfLifeUnit: '天' });
    assert.deepEqual(csv.parseShelfLifeText('2周'), { shelfLife: '14', shelfLifeUnit: '天' });
    assert.deepEqual(csv.parseShelfLifeText('3年'), { shelfLife: '3', shelfLifeUnit: '年' });
    assert.deepEqual(csv.parseShelfLifeText('12'), { shelfLife: '12', shelfLifeUnit: '月' });
    assert.deepEqual(csv.parseShelfLifeText(''), { shelfLife: '', shelfLifeUnit: '月' });
});

test('stripBom 干掉 Excel 的 BOM，否则第一列认不出来', () => {
    const withBom = '\uFEFF类型,商品条码';
    assert.equal(csv.stripBom(withBom), '类型,商品条码');

    // BOM 去掉后表头才匹配得上「类型」
    const rows = csv.parseCsvText(csv.stripBom('\uFEFF' + [
        '类型,商品条码,商品名称,扫描日期,有效期,生产日期,保质期,状态',
        '"映射","6901234567890","牛奶","","","","",""'
    ].join('\n')));
    assert.equal(csv.csvRowsToRecords(rows, deps).mappings.length, 1);
});

test('parseCsvText 跳过全空行，且不用表头名定位数据', () => {
    const rows = csv.parseCsvText('a,b\n\n,,\n1,2');
    assert.deepEqual(rows, [['a', 'b'], ['1', '2']]);
});

test('同一个条码的映射在文件里出现多次时只留最后一条', () => {
    const text = [
        '类型,商品条码,商品名称,扫描日期,有效期,生产日期,保质期,状态',
        '"映射","690","旧名字","","","","",""',
        '"映射","690","新名字","","","","",""'
    ].join('\n');

    const back = csv.csvRowsToRecords(csv.parseCsvText(text), deps);
    assert.equal(back.mappings.length, 1);
    assert.equal(back.mappings[0].productName, '新名字');
});
