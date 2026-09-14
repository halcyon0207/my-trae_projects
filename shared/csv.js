/*
 * CSV 导入导出（共享模块）
 *
 * 导出 = 一份完整备份（商品 + 条码映射，含处置信息），导入要能读回自己导出的文件，
 * 也要能读旧版本导出的 8 列文件 —— 所以表头后面追加的 3 列必须只按位置读，不能按表头名找。
 *
 * 浏览器里挂到 window.ExpiryShared.csv；Node 里直接 require。
 * 依赖（uid 生成、今天日期、状态文案）由调用方通过 deps 传进来，避免这里反向依赖别的模块。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else {
        root.ExpiryShared = root.ExpiryShared || {};
        root.ExpiryShared.csv = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const CSV_HEADERS = ['类型', '商品条码', '商品名称', '扫描日期', '有效期', '生产日期', '保质期', '状态',
                         '处置方式', '处置日期', '处置备注'];

    // CSV 单元格转义：内部引号加倍，否则商品名里带逗号会把列冲错
    function csvCell(value) {
        const text = value === undefined || value === null ? '' : String(value);
        return '"' + text.replace(/"/g, '""') + '"';
    }

    // 解析CSV文本：正确处理引号包裹、引号内的逗号和换行
    function parseCsvText(text) {
        const QUOTE = 34;   // "
        const COMMA = 44;   // ,
        const LF = 10;      // 换行
        const CR = 13;      // 回车

        const rows = [];
        let row = [];
        let field = '';
        let inQuotes = false;

        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);

            if (inQuotes) {
                if (code === QUOTE) {
                    if (text.charCodeAt(i + 1) === QUOTE) { field += '"'; i++; }
                    else inQuotes = false;
                } else {
                    field += text[i];
                }
            } else if (code === QUOTE) {
                inQuotes = true;
            } else if (code === COMMA) {
                row.push(field); field = '';
            } else if (code === LF) {
                row.push(field); rows.push(row); row = []; field = '';
            } else if (code !== CR) {
                field += text[i];
            }
        }

        if (field !== '' || row.length > 0) {
            row.push(field);
            rows.push(row);
        }

        return rows.filter(function (r) {
            return r.some(function (c) { return String(c).trim() !== ''; });
        });
    }

    // 去掉文件开头的 BOM，否则第一列“类型”识别不出来
    function stripBom(text) {
        return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    }

    // 把“7天”“12个月”“3年”“12”这样的保质期文本拆成 数量 + 单位
    function parseShelfLifeText(text) {
        const raw = String(text || '').trim();
        const m = /^(\d+(?:\.\d+)?)\s*(天|日|周|个月|月|年)?/.exec(raw);
        if (!m) return { shelfLife: '', shelfLifeUnit: '月' };

        let value = Number(m[1]);
        let unit = m[2] || '月';
        if (unit === '日') unit = '天';
        if (unit === '周') { unit = '天'; value = value * 7; }
        if (unit === '个月') unit = '月';

        return { shelfLife: String(parseInt(value, 10)), shelfLifeUnit: unit };
    }

    // 生成 CSV 正文（不含 BOM，调用方按需要加 \uFEFF）
    // deps: { getStatusText, getExpiryStatus, formatShelfLife }
    function buildCsvText(products, mappings, deps) {
        const d = deps || {};
        const statusText = d.getStatusText || function (s) { return s; };
        const expiryStatus = d.getExpiryStatus || function () { return 'unknown'; };
        const shelfLifeText = d.formatShelfLife || function () { return '-'; };

        const rows = [];

        (products || []).forEach(function (product) {
            const shelfLife = shelfLifeText(product);
            rows.push([
                product.type || '商品',
                product.barcode,
                product.productName,
                product.scanDate,
                product.validity,
                product.productionDate || '',
                shelfLife === '-' ? '' : shelfLife,
                statusText(expiryStatus(product.validity)),
                product.handledAction || '',
                product.handledAt || '',
                product.handledNote || ''
            ]);
        });

        // 映射也一起导出，否则换台设备映射就全丢了
        (mappings || []).forEach(function (mapping) {
            rows.push(['映射', mapping.barcode, mapping.productName, '', '', '', '', '', '', '', '']);
        });

        return [
            CSV_HEADERS.join(','),
            ...rows.map(function (row) {
                return row.map(csvCell).join(',');
            })
        ].join('\n');
    }

    // CSV 行 → 记录。返回 { products, mappings, productCount, mappingCount }，由调用方决定怎么并入本地数据。
    // deps: { makeUid, todayLocal, now }
    function csvRowsToRecords(rows, deps) {
        const d = deps || {};
        const makeUid = d.makeUid || function () { return 'p' + Date.now().toString(36); };
        const todayLocal = d.todayLocal || function () { return ''; };
        const nowIso = (d.now || new Date()).toISOString();

        const list = rows || [];
        const outProducts = [];
        const mappingsByBarcode = new Map();

        // 跳过表头，顺序：类型、商品条码、商品名称、扫描日期、有效期、生产日期、保质期、状态、处置方式、处置日期、处置备注
        for (let i = 1; i < list.length; i++) {
            const row = list[i];
            const type = (row[0] || '').trim();
            const barcode = (row[1] || '').trim();
            const productName = (row[2] || '').trim();

            if (!barcode) continue;

            if (type === '商品') {
                const shelf = parseShelfLifeText(row[6]);

                // 处置信息在最后 3 列。老备份文件没有这几列，读出来是空，按未处理处理
                const handledAction = (row[8] || '').trim();
                let handledAt = (row[9] || '').trim();
                // 只有处置方式、没有日期时补今天；不然 handledAt 为空会被当成未处理，进不了已处理列表
                if (handledAction && !handledAt) handledAt = todayLocal();

                outProducts.push({
                    uid: makeUid(),      // 导入的记录也要有 uid，否则同步时无法与云端一一对应
                    id: Date.now() + i,
                    type: '商品',
                    barcode: barcode,
                    productName: productName,
                    scanDate: (row[3] || '').trim(),
                    validity: (row[4] || '').trim(),
                    productionDate: (row[5] || '').trim(),
                    shelfLife: shelf.shelfLife,
                    shelfLifeUnit: shelf.shelfLifeUnit,
                    handledAction: handledAction,
                    handledAt: handledAt,
                    handledNote: (row[10] || '').trim(),
                    updatedAt: nowIso,   // 导入 = 本机此刻改过，合并时按它算新旧
                    createdAt: nowIso
                });
            } else if (type === '映射') {
                // 一个条码只留最后一条
                mappingsByBarcode.set(barcode, {
                    id: Date.now() + i + 1000,   // 确保ID与商品不冲突
                    barcode: barcode,
                    productName: productName,
                    updatedAt: nowIso
                });
            }
        }

        return {
            products: outProducts,
            mappings: Array.from(mappingsByBarcode.values()),
            productCount: outProducts.length,
            mappingCount: mappingsByBarcode.size
        };
    }

    return {
        CSV_HEADERS: CSV_HEADERS,
        csvCell: csvCell,
        parseCsvText: parseCsvText,
        stripBom: stripBom,
        parseShelfLifeText: parseShelfLifeText,
        buildCsvText: buildCsvText,
        csvRowsToRecords: csvRowsToRecords
    };
});
