'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const merge = require('../shared/merge.js');

// 下面每个 test 都对应一个真实踩过的坑（见 README 更新日志），改动 shared/merge.js 时必须全绿

function product(over) {
    return Object.assign({
        uid: 'u1',
        barcode: '6901234567890',
        productName: '牛奶',
        productionDate: '2026-08-01',
        validity: '2026-11-01',
        updatedAt: '2026-09-01T00:00:00.000Z'
    }, over || {});
}

test('同一商品不同批次不会互相覆盖（v1.2.0 的坑）', () => {
    const cloud = [product({ uid: 'u1', productionDate: '2026-08-01', validity: '2026-11-01' })];
    const local = [product({ uid: 'u2', productionDate: '2026-09-01', validity: '2026-12-01' })];

    const r = merge.mergeProducts(cloud, local, [], true);

    assert.equal(r.products.length, 2, '条码相同、生产日期不同，必须是两条');
    assert.deepEqual(r.products.map((p) => p.uid).sort(), ['u1', 'u2']);
});

test('谁改得晚用谁，且与同步方向无关（v1.3.1 的坑）', () => {
    const cloud = [product({ handledAt: '2026-09-10', updatedAt: '2026-09-10T00:00:00.000Z', handledAction: '已用完' })];
    const local = [product({ updatedAt: '2026-09-01T00:00:00.000Z' })];

    // 本机是旧副本：推送方向不能拿旧的盖掉云端刚标记的处置
    const push = merge.mergeProducts(cloud, local, [], true);
    assert.equal(push.products[0].handledAction, '已用完');

    // 拉取方向也不能把本机改得更晚的记录抹掉
    const cloudOld = [product({ updatedAt: '2026-09-01T00:00:00.000Z' })];
    const localNew = [product({ updatedAt: '2026-09-10T00:00:00.000Z', handledAction: '已丢弃', handledAt: '2026-09-10' })];
    const pull = merge.mergeProducts(cloudOld, localNew, [], false);
    assert.equal(pull.products[0].handledAction, '已丢弃');
});

test('删除留墓碑：墓碑更新时，别的设备手里的旧副本会被删掉（v1.3.2 的坑）', () => {
    const cloud = [];   // 云端已经没有活记录
    const local = [product({ updatedAt: '2026-09-01T00:00:00.000Z' })];
    const localTombstones = [merge.makeProductTombstone(product(), '2026-09-10T00:00:00.000Z')];

    const r = merge.mergeProducts(cloud, local, localTombstones, true);

    assert.equal(r.products.length, 0, '删除标记更新，本地那份要被删掉');
    assert.equal(r.tombstones.length, 1, '墓碑要留着，下次同步继续压制别的设备');
});

test('删掉之后又在别处改过 → 墓碑作废，记录保留', () => {
    const cloud = [product({ updatedAt: '2026-09-12T00:00:00.000Z', handledAction: '已退换', handledAt: '2026-09-12' })];
    const localTombstones = [merge.makeProductTombstone(product(), '2026-09-10T00:00:00.000Z')];

    const r = merge.mergeProducts(cloud, [], localTombstones, true);

    assert.equal(r.products.length, 1, '记录比墓碑新，说明删完又改过，不能删');
    assert.equal(r.tombstones.length, 0, '失效的墓碑要清掉');
});

test('云端老记录没有 uid 时靠「条码 + 生产日期」认领，不会变成两条', () => {
    const cloud = [product({ uid: '' })];                       // 历史数据，没有 uid
    const local = [product({ uid: 'local-uid', updatedAt: '2026-09-05T00:00:00.000Z' })];

    const r = merge.mergeProducts(cloud, local, [], true);

    assert.equal(r.products.length, 1, '同一条码 + 同生产日期只应留一条');
    assert.equal(r.products[0].uid, 'local-uid', '身份要稳定，下次同步两边才认得出是同一条');
});

test('老记录用 handledAt 兜底判新旧，无需迁移', () => {
    const cloud = [product({ updatedAt: '', handledAt: '2026-09-10', handledAction: '已用完' })];
    const local = [product({ updatedAt: '', handledAt: '2026-09-05' })];

    const r = merge.mergeProducts(cloud, local, [], true);
    assert.equal(r.products[0].handledAction, '已用完', '没有 updatedAt 时，用处置日期比新旧');
});

test('两边时间完全打平时按 preferLocal 决定', () => {
    const cloud = [product({ productName: '云端名字' })];
    const local = [product({ productName: '本机名字' })];

    assert.equal(merge.mergeProducts(cloud, local, [], true).products[0].productName, '本机名字');
    assert.equal(merge.mergeProducts(cloud, local, [], false).products[0].productName, '云端名字');
});

test('条码 + 生产日期相同的重复记录会收敛成一条', () => {
    const local = [product({ uid: 'a' }), product({ uid: 'b' })];   // uid 不同，内容同款

    const r = merge.mergeProducts([], local, [], true);
    assert.equal(r.products.length, 1, '同款记录重复时收敛回一条');
});

test('没有条码的记录只按 uid 区分，不会被误合并', () => {
    const local = [product({ uid: 'a', barcode: '', productName: '手写A' }),
                   product({ uid: 'b', barcode: '', productName: '手写B' })];

    const r = merge.mergeProducts([], local, [], true);
    assert.equal(r.products.length, 2);
});

test('映射按条码合并：谁新用谁', () => {
    const cloud = [{ barcode: '690', productName: '旧名字', updatedAt: '2026-09-01T00:00:00.000Z' }];
    const local = [{ barcode: '690', productName: '新名字', updatedAt: '2026-09-10T00:00:00.000Z' }];

    const r = merge.mergeMappings(cloud, local, [], true);
    assert.equal(r.mappings.length, 1);
    assert.equal(r.mappings[0].productName, '新名字');
});

test('映射墓碑同样生效，且「删完又改」能救回来', () => {
    const local = [{ barcode: '690', productName: '牛奶', updatedAt: '2026-09-01T00:00:00.000Z' }];
    const tomb = [merge.makeMappingTombstone({ barcode: '690', productName: '牛奶' }, '2026-09-10T00:00:00.000Z')];

    const deleted = merge.mergeMappings([], local, tomb, true);
    assert.equal(deleted.mappings.length, 0);
    assert.equal(deleted.tombstones.length, 1);

    const revived = merge.mergeMappings(
        [{ barcode: '690', productName: '牛奶', updatedAt: '2026-09-12T00:00:00.000Z' }], [], tomb, true);
    assert.equal(revived.mappings.length, 1, '映射在墓碑之后改过，应以改动为准');
});

test('makeUid 生成互不相同的标识', () => {
    const set = new Set();
    for (let i = 0; i < 200; i++) set.add(merge.makeUid());
    assert.equal(set.size, 200);
});

test('ensureProductUids 给老记录补 uid，且不会凭空多出一条', () => {
    const list = [product({ uid: '' }), product({ uid: '', productionDate: '2026-09-01' })];
    const filled = merge.ensureProductUids(list, null);

    assert.ok(filled[0].uid && filled[1].uid);
    assert.notEqual(filled[0].uid, filled[1].uid, '生产日期不同是不同批次，uid 不能相同');
});
