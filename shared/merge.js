/*
 * 记录合并（共享模块）—— 同步逻辑里最要紧的一段，只此一份
 *
 * 谁在用：
 *   · 云函数 product-api  在写入仓库前合并「云端那份」和「本机那份」
 *   · 浏览器              用里面的 uid / 墓碑 / 时间戳工具维护本地记录
 *   · 单元测试            tests/merge.test.js 覆盖了历史上的三个坑
 *
 * 合并规则（两个方向都跑同一套，所以先点「同步」还是先点「获取最新数据」都不丢数据）：
 *   · 同 uid 的记录逐条比最后修改时间，谁新用谁
 *   · uid 对不上时退回按「条码 + 生产日期」认领，避免同一件东西在两台设备上各自补过 uid
 *   · 删除留墓碑（带 deletedAt 的记录）：墓碑更新就删掉记录，记录更新就作废墓碑
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else {
        root.ExpiryShared = root.ExpiryShared || {};
        root.ExpiryShared.merge = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // 商品用 uid 做唯一标识。
    // 以前拿「条码」当唯一键，同一箱牛奶这周和下月各买一次（条码相同、生产日期不同），
    // 同步时后录入的会把前一条覆盖掉，云端和本地一起少一条数据。
    function makeUid() {
        return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }

    // 老记录的指纹：条码 + 生产日期。用来判断「云端的这条」和「本地的这条」是不是同一样东西
    function productFingerprint(product) {
        return String(product.barcode || '') + '\u0001' + String(product.productionDate || '');
    }

    // 给缺 uid 的记录补 uid；uidIndex 能查到同款记录时优先沿用它的 uid，避免迁移时凭空多出一条
    function ensureProductUids(list, uidIndex) {
        return (list || []).map(function (product) {
            if (!product.uid) {
                const fingerprint = productFingerprint(product);
                product.uid = (uidIndex && uidIndex[fingerprint]) || makeUid();
            }
            return product;
        });
    }

    // 本地记录按指纹建索引：指纹 -> uid
    function buildUidIndex(list) {
        const index = {};
        (list || []).forEach(function (product) {
            if (product.uid) index[productFingerprint(product)] = product.uid;
        });
        return index;
    }

    /* ---- 删除标记（墓碑） ---- */
    // 判断一条记录是「活记录」还是「删除标记」
    function isTombstone(record) {
        return !!(record && record.deletedAt);
    }

    // 商品墓碑：留着条码和生产日期，因为云端还挂着没 uid 的老记录时，
    // 只能靠「条码 + 生产日期」这个指纹把它认出来（见 mergeProducts）
    function makeProductTombstone(product, deletedAt) {
        return {
            uid: product.uid || '',
            barcode: product.barcode || '',
            productName: product.productName || '',
            productionDate: product.productionDate || '',
            deletedAt: deletedAt,
            updatedAt: deletedAt
        };
    }

    // 映射墓碑：映射按条码唯一，有条码就够了
    function makeMappingTombstone(mapping, deletedAt) {
        return {
            barcode: mapping.barcode || '',
            productName: mapping.productName || '',
            deletedAt: deletedAt,
            updatedAt: deletedAt
        };
    }

    /* ---- 记录的最后修改时间：跨设备同步靠它判断「哪份更新」 ---- */
    // 记录被改动时打一次时间戳。新增、编辑、标记处置、撤销处置、改名、导入都要调。
    function touchRecord(record) {
        if (record) record.updatedAt = new Date().toISOString();
        return record;
    }

    // 取记录的最后修改时间（毫秒）。没有 updatedAt 的老记录用 handledAt 兜底：
    // 标记过处置的老记录，至少是在那一天之后才变成现在这样的；从没被动过的算 0。
    //
    // 这条兜底不能省 —— 存量数据全是老格式，少了它老记录之间就没法比新旧，
    // 只能退回「一边通吃」，又回到「换设备看不到已处理」那个坑里。
    function recordModifiedTime(record) {
        if (!record) return 0;

        const updated = Date.parse(record.updatedAt);
        if (!isNaN(updated)) return updated;

        // 墓碑万一没有 updatedAt，至少要按删除时间算
        const deleted = Date.parse(record.deletedAt);
        if (!isNaN(deleted)) return deleted;

        const handled = Date.parse(record.handledAt);
        return isNaN(handled) ? 0 : handled;
    }

    // 同一条记录两边都有时，取最后修改时间更晚的那条。
    // 只有时间完全相同（或两边都取不到时间）才用 preferLocal 决定：
    //   preferLocal = true  → 同步（推送）方向：本机优先
    //   preferLocal = false → 获取最新数据（拉取）方向：云端优先
    function pickNewerRecord(cloudRecord, localRecord, preferLocal) {
        const cloudTime = recordModifiedTime(cloudRecord);
        const localTime = recordModifiedTime(localRecord);

        if (cloudTime === localTime) return preferLocal ? localRecord : cloudRecord;
        return cloudTime > localTime ? cloudRecord : localRecord;
    }

    // 按 uid 合并商品，返回 { products, tombstones }：
    //   products   —— 活记录，同 uid 的冲突逐条比最后修改时间，谁新用谁
    //   tombstones —— 生效的删除标记，两边都留着，下次同步继续压制别的设备手里的旧副本
    //
    // 云端那份里混着墓碑（带 deletedAt），先拆开。删除与「删完又改」的判定：
    //   · 墓碑更新 → 记录被删掉，别的设备手里的旧副本也一并消失
    //   · 记录更新 → 这条在别处被改过，以改动为准，墓碑作废（删完还能救回来）
    // preferLocal 只在时间打平时起作用（两边都没动过、内容却不一样）。
    function mergeProducts(cloudList, localList, localTombstones, preferLocal) {
        // 云端列表里混着墓碑，先按 deletedAt 拆开
        const cloudLive = [];
        const cloudTombstones = [];
        (cloudList || []).forEach(function (record) {
            if (!record) return;
            (isTombstone(record) ? cloudTombstones : cloudLive).push(record);
        });

        // 必须先给本地记录补齐 uid，再按指纹建索引。
        // 否则本地记录恰好都没 uid 时，云端的老记录匹配不到、会被当成新记录重复插入。
        const localWithUid = ensureProductUids(localList, null);
        const uidIndex = buildUidIndex(localWithUid);
        const cloudWithUid = ensureProductUids(cloudLive, uidIndex);

        // 1. 活记录：云端那份先铺底，输出顺序就稳定，同步前后列表不会莫名重排
        const liveByUid = new Map();
        const cloudByUid = new Map();           // 云端：uid → 记录
        const cloudByFingerprint = new Map();   // 云端：条码 + 生产日期 → 记录
        const cloudByBarcode = new Map();       // 云端：条码 → 记录（有一边缺生产日期时的兜底）

        function pushIndex(index, key, record) {
            const bucket = index.get(key);
            if (bucket) bucket.push(record);
            else index.set(key, [record]);
        }

        cloudWithUid.forEach(function (product) {
            liveByUid.set(String(product.uid), product);
            cloudByUid.set(String(product.uid), product);
            pushIndex(cloudByFingerprint, productFingerprint(product), product);
            pushIndex(cloudByBarcode, String(product.barcode || ''), product);
        });

        // 已经配过对的云端记录，不能再被本机另一条认领
        const claimedUids = new Set();

        // uid 对不上时（同一件东西在两台设备上各自补过一个 uid）退回按内容认领：
        // 先比「条码 + 生产日期」，有一边没记生产日期时再退一步只比条码。
        // 少了这一步，另一台设备点「获取最新数据」会看到整份列表翻倍，
        // 而且本机这条（例如刚标记的「已处理」）和云端那条被算成两件东西
        function claimCloudRecord(product) {
            // 没有条码就没法可靠判断是不是同一条（空指纹会把一堆无关记录串在一起），只按 uid 区分
            if (!product.barcode) return null;

            const byFingerprint = cloudByFingerprint.get(productFingerprint(product)) || [];
            // 两边都写了生产日期时，日期不同就是不同批次，不能算同一条
            const byBarcode = (cloudByBarcode.get(String(product.barcode)) || [])
                .filter(function (record) {
                    return !product.productionDate || !record.productionDate;
                });

            const candidates = byFingerprint.concat(byBarcode);
            for (let i = 0; i < candidates.length; i++) {
                const key = String(candidates[i].uid);
                if (!claimedUids.has(key)) {
                    claimedUids.add(key);
                    return candidates[i];
                }
            }
            return null;
        }

        localWithUid.forEach(function (product) {
            const key = String(product.uid);
            const byUid = cloudByUid.get(key);

            if (byUid) {
                claimedUids.add(key);
                liveByUid.set(key, pickNewerRecord(byUid, product, preferLocal));
                return;
            }

            const claimed = claimCloudRecord(product);
            if (claimed) {
                // 身份沿用云端那条：下次同步两边才认得出是同一条，不会再各留一份
                const winner = pickNewerRecord(claimed, product, preferLocal);
                winner.uid = claimed.uid;
                liveByUid.set(String(claimed.uid), winner);
                return;
            }

            // 只在本机存在、云端没有的记录，原样留下，下次同步会推上去
            liveByUid.set(key, product);
        });

        // 2. 兜底去重：条码 + 生产日期相同的记录只留最近改过的一条。
        // 本机列表如果已经被「uid 不一致」撑成了两份，这一步顺手收敛回一条，不用手工删重复
        const deduped = [];
        const fingerprintIndex = new Map();

        liveByUid.forEach(function (product) {
            // 没有条码就没法可靠判断是不是同一条，只按 uid 区分
            const fingerprint = product.barcode
                ? productFingerprint(product)
                : 'uid\u0001' + String(product.uid);
            const at = fingerprintIndex.get(fingerprint);

            if (at === undefined) {
                fingerprintIndex.set(fingerprint, deduped.length);
                deduped.push(product);
                return;
            }

            const kept = deduped[at];
            const winner = pickNewerRecord(kept, product, preferLocal);

            // 内容可以换成更新的那份，身份要留住云端已经写下的那个 uid，
            // 否则别的设备手里那份又会对不上、重新分裂成两条
            if (String(kept.uid) !== String(product.uid)) {
                if (cloudByUid.has(String(kept.uid))) winner.uid = kept.uid;
                else if (cloudByUid.has(String(product.uid))) winner.uid = product.uid;
            }

            deduped[at] = winner;
        });

        // 3. 墓碑：同一件东西两边可能各留过一条（删了又删），取时间最新的那条
        const tombByKey = new Map();

        function rememberTombstone(tombstone) {
            if (!tombstone || !tombstone.barcode) return;

            const key = tombstone.uid ? 'u' + tombstone.uid : 'f' + productFingerprint(tombstone);
            const existing = tombByKey.get(key);
            if (!existing || recordModifiedTime(tombstone) > recordModifiedTime(existing)) {
                tombByKey.set(key, tombstone);
            }
        }

        cloudTombstones.forEach(rememberTombstone);
        (localTombstones || []).forEach(rememberTombstone);

        // 4. 墓碑与活记录对账
        const finalByUid = new Map();
        const liveByFingerprint = new Map();
        deduped.forEach(function (product) {
            finalByUid.set(String(product.uid), product);
            liveByFingerprint.set(productFingerprint(product), product);
        });

        const deletedUids = new Set();
        const tombstones = [];

        tombByKey.forEach(function (tombstone) {
            // 优先按 uid 找；云端还挂着没 uid 的老记录时，靠「条码 + 生产日期」认领
            let target = tombstone.uid ? finalByUid.get(String(tombstone.uid)) : null;
            if (!target) target = liveByFingerprint.get(productFingerprint(tombstone));

            if (target && recordModifiedTime(target) > recordModifiedTime(tombstone)) {
                return;   // 删掉之后又在别处改过 → 以改动为准，墓碑作废
            }
            if (target) deletedUids.add(String(target.uid));
            tombstones.push(tombstone);
        });

        return {
            products: deduped.filter(function (product) {
                return !deletedUids.has(String(product.uid));
            }),
            tombstones: tombstones
        };
    }

    // 映射按条码合并：一个条码本来就只该对应一个名称，这里特意不用 uid。
    // 冲突判定与 mergeProducts 一致（先比修改时间，打平才看 preferLocal），同样返回墓碑
    function mergeMappings(cloudList, localList, localTombstones, preferLocal) {
        const cloudLive = [];
        const cloudTombstones = [];

        (cloudList || []).forEach(function (record) {
            if (!record || !record.barcode) return;
            (isTombstone(record) ? cloudTombstones : cloudLive).push(record);
        });

        const liveByBarcode = new Map();
        cloudLive.forEach(function (mapping) {
            liveByBarcode.set(String(mapping.barcode), mapping);
        });

        (localList || []).forEach(function (mapping) {
            if (!mapping || !mapping.barcode) return;

            const key = String(mapping.barcode);
            const cloudRecord = liveByBarcode.get(key);
            liveByBarcode.set(key, cloudRecord ? pickNewerRecord(cloudRecord, mapping, preferLocal) : mapping);
        });

        const tombByBarcode = new Map();

        function rememberTombstone(tombstone) {
            if (!tombstone || !tombstone.barcode) return;

            const key = String(tombstone.barcode);
            const existing = tombByBarcode.get(key);
            if (!existing || recordModifiedTime(tombstone) > recordModifiedTime(existing)) {
                tombByBarcode.set(key, tombstone);
            }
        }

        cloudTombstones.forEach(rememberTombstone);
        (localTombstones || []).forEach(rememberTombstone);

        const deletedBarcodes = new Set();
        const tombstones = [];

        tombByBarcode.forEach(function (tombstone) {
            const target = liveByBarcode.get(String(tombstone.barcode));
            if (target && recordModifiedTime(target) > recordModifiedTime(tombstone)) {
                return;   // 删掉之后又改过 → 以改动为准，墓碑作废
            }
            if (target) deletedBarcodes.add(String(target.barcode));
            tombstones.push(tombstone);
        });

        return {
            mappings: Array.from(liveByBarcode.values()).filter(function (mapping) {
                return !deletedBarcodes.has(String(mapping.barcode));
            }),
            tombstones: tombstones
        };
    }

    return {
        makeUid: makeUid,
        productFingerprint: productFingerprint,
        ensureProductUids: ensureProductUids,
        buildUidIndex: buildUidIndex,
        isTombstone: isTombstone,
        makeProductTombstone: makeProductTombstone,
        makeMappingTombstone: makeMappingTombstone,
        touchRecord: touchRecord,
        recordModifiedTime: recordModifiedTime,
        pickNewerRecord: pickNewerRecord,
        mergeProducts: mergeProducts,
        mergeMappings: mergeMappings
    };
});
