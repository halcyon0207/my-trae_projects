// 数据存储
let products = JSON.parse(localStorage.getItem('products')) || [];
let productMappings = JSON.parse(localStorage.getItem('productMappings')) || [];

// LeanCloud 初始化
const APP_ID = 'Cg0xX6uA9mETD5p7zQcTzk3m-gzGzoHsz'; // 用户提供的 LeanCloud App ID
const APP_KEY = 'GAEgrcnZ3NRsEYvB1n6CyyGJ'; // 用户提供的 LeanCloud App Key
const SERVER_URL = 'https://cg0xx6ua.lc-cn-n1-shared.com'; // 用户提供的 LeanCloud 服务器地址

console.log('准备初始化LeanCloud:', { APP_ID, APP_KEY, SERVER_URL });

AV.init({
    appId: APP_ID,
    appKey: APP_KEY,
    serverURL: SERVER_URL
});

console.log('LeanCloud初始化完成:', { appId: AV.applicationId, serverURL: AV.serverURL });

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', function() {
    initializeApp();
    
    // 初始化实时数据监听
    initializeLiveQuery();
});

function initializeApp() {
    console.log('initializeApp函数被调用');
    // 绑定事件监听器
    bindEventListeners();
    
    // 加载数据
    loadData();
    
    // 更新商品列表
    updateProductList();
    
    // 更新映射列表
    updateMappingList();
    
    // 初始化图表
    initializeChart();
    
    // 确保添加商品表单默认为空
    try {
        const productForm = document.getElementById('productForm');
        if (productForm) {
            productForm.reset();
            console.log('表单已重置');
        } else {
            console.error('未找到商品表单');
        }
    } catch (error) {
        console.error('重置表单失败:', error);
    }
}

function bindEventListeners() {
    // 商品表单提交
    document.getElementById('productForm').addEventListener('submit', handleProductSubmit);
    
    // 条码输入变化
    document.getElementById('barcode').addEventListener('input', handleBarcodeChange);
    
    // 生产日期或保质期变化时自动计算到期日期
    document.getElementById('productionDate').addEventListener('change', calculateExpiryDate);
    document.getElementById('shelfLife').addEventListener('input', calculateExpiryDate);
    
    // 导出CSV
    document.getElementById('exportBtn').addEventListener('click', exportToCSV);
    
    // 导入CSV
    document.getElementById('importBtn').addEventListener('click', function() {
        document.getElementById('importFile').click();
    });
    document.getElementById('importFile').addEventListener('change', importFromCSV);
    
    // 清空所有数据
    document.getElementById('clearBtn').addEventListener('click', clearAllData);
    
    // 同步数据
    document.getElementById('syncBtn').addEventListener('click', syncData);
    
    // 获取最新数据
    document.getElementById('fetchBtn').addEventListener('click', fetchLatestDataFromCloud);
    
    // 添加映射
    document.getElementById('addMappingBtn').addEventListener('click', addMapping);
}

// 处理条码输入变化
function handleBarcodeChange() {
    const barcode = document.getElementById('barcode').value;
    const productNameInput = document.getElementById('productName');
    
    // 查找映射
    const mapping = productMappings.find(item => item.barcode === barcode);
    if (mapping) {
        productNameInput.value = mapping.productName;
    } else {
        productNameInput.value = '';
    }
}

// 计算到期日期
function calculateExpiryDate() {
    const productionDate = document.getElementById('productionDate').value;
    const shelfLife = document.getElementById('shelfLife').value;
    const validityInput = document.getElementById('validity');
    
    if (productionDate && shelfLife) {
        const date = new Date(productionDate);
        date.setMonth(date.getMonth() + parseInt(shelfLife));
        validityInput.value = date.toISOString().split('T')[0];
    }
}

// 处理商品表单提交
function handleProductSubmit(e) {
    e.preventDefault();
    
    const formData = new FormData(e.target);
    const isEditing = e.target.dataset.editingId;
    
    if (isEditing) {
        // 编辑模式: 更新现有商品
        // 不再使用parseInt，保持id的原始类型（可能是字符串或数字）
        const productId = isEditing;
        const productIndex = products.findIndex(p => p.id == productId); // 使用==进行宽松比较
        
        if (productIndex !== -1) {
            products[productIndex] = {
                ...products[productIndex],
                barcode: formData.get('barcode'),
                productName: formData.get('productName'),
                // 类型和扫描日期字段不再从表单获取，但保持现有值
                productionDate: formData.get('productionDate'),
                shelfLife: formData.get('shelfLife'),
                validity: formData.get('validity')
            };
            
            saveProducts();
            updateProductList();
            updateChart();
            
            // 重置表单和编辑状态
            e.target.reset();
            delete e.target.dataset.editingId;
            document.querySelector('#productForm button[type="submit"]').textContent = '添加商品';
            
            // 取消自动同步，仅通过手动点击按钮触发
            
            alert('商品更新成功！');
        }
    } else {
        // 添加模式: 创建新商品
        const today = new Date().toISOString().split('T')[0];
        const product = {
            id: Date.now(),
            barcode: formData.get('barcode'),
            productName: formData.get('productName'),
            type: '商品', // 默认类型为"商品"
            scanDate: today, // 默认扫描日期为当前日期
            productionDate: formData.get('productionDate'),
            shelfLife: formData.get('shelfLife'),
            validity: formData.get('validity'),
            createdAt: new Date().toISOString()
        };
        
        // 添加到商品列表
        products.push(product);
        
        // 保存到本地存储
        saveProducts();
        
        // 更新列表
        updateProductList();
        
        // 更新图表
        updateChart();
        
        // 重置表单
        e.target.reset();
        
        // 取消自动同步，仅通过手动点击按钮触发
        
        alert('商品添加成功！');
    }
}

// 保存商品数据
function saveProducts() {
    localStorage.setItem('products', JSON.stringify(products));
}

// 保存映射数据
function saveMappings() {
    localStorage.setItem('productMappings', JSON.stringify(productMappings));
}

// 更新商品列表
function updateProductList() {
    console.log('updateProductList函数被调用，原始商品数量:', products.length);
    const tbody = document.querySelector('#productTable tbody');
    tbody.innerHTML = '';
    
    // 按到期日期排序（已过期的排前面，然后按有效期从近到远）
    const sortedProducts = [...products].sort((a, b) => {
        const dateA = new Date(a.validity);
        const dateB = new Date(b.validity);
        const result = dateA - dateB;
        return result;
    });
    
    console.log('排序后的商品列表:', sortedProducts);
    
    sortedProducts.forEach((product, index) => {
        const row = document.createElement('tr');
        const status = getExpiryStatus(product.validity);
        
        row.innerHTML = `
            <td>${index + 1}</td>
            <td>${product.barcode}</td>
            <td>${product.productName}</td>
            <td>${product.type}</td>
            <td>${product.scanDate}</td>
            <td>${product.productionDate || '-'}</td>
            <td>${product.shelfLife || '-'}</td>
            <td>${product.validity}</td>
            <td><span class="status status-${status}">${getStatusText(status)}</span></td>
            <td>
                <button class="btn btn-secondary" onclick="editProduct('${product.id}')">编辑</button>
                <button class="btn btn-danger" onclick="deleteProduct('${product.id}')">删除</button>
            </td>
        `;
        
        tbody.appendChild(row);
    });
}

// 获取到期状态
function getExpiryStatus(validity) {
    const today = new Date();
    const expiry = new Date(validity);
    const diffTime = expiry - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays < 0) return 'expired';
    if (diffDays <= 30) return 'danger';
    if (diffDays <= 90) return 'warning';
    return 'normal';
}

// 获取状态文本
function getStatusText(status) {
    const statusMap = {
        normal: '正常',
        warning: '1-3个月',
        danger: '1个月内',
        expired: '已过期'
    };
    return statusMap[status] || status;
}

// 编辑商品（全局函数，以便HTML onclick事件调用）
window.editProduct = function(id) {
    console.log('editProduct函数被调用，id:', id, '类型:', typeof id);
    console.log('当前商品列表:', products.map(p => ({ id: p.id, type: typeof p.id })));
    
    // 尝试使用不同的比较方式查找商品
    let product = products.find(p => p.id === id);
    console.log('使用===查找结果:', product);
    
    if (!product) {
        product = products.find(p => p.id == id);
        console.log('使用==查找结果:', product);
    }
    
    if (!product) {
        product = products.find(p => String(p.id) === String(id));
        console.log('使用字符串转换查找结果:', product);
    }
    
    if (!product) {
        console.log('未找到商品，id:', id);
        alert('未找到指定商品');
        return;
    }
    
    try {
        // 填充表单（只填充仍然存在的字段）
        document.getElementById('barcode').value = product.barcode;
        document.getElementById('productName').value = product.productName;
        document.getElementById('productionDate').value = product.productionDate;
        document.getElementById('shelfLife').value = product.shelfLife;
        document.getElementById('validity').value = product.validity;
        
        // 设置编辑模式
        document.getElementById('productForm').dataset.editingId = id;
        
        // 修改提交按钮文本
        document.querySelector('#productForm button[type="submit"]').textContent = '更新商品';
        
        console.log('编辑功能执行成功');
    } catch (error) {
        console.error('编辑功能执行失败:', error);
    }
}

// 删除商品（全局函数，以便HTML onclick事件调用）
window.deleteProduct = function(id) {
    console.log('deleteProduct函数被调用，id:', id, '类型:', typeof id);
    console.log('删除前商品列表:', products.length, '条');
    
    if (confirm('确定要删除这个商品吗？')) {
        // 使用多种比较方式确保兼容不同类型的ID
        const initialLength = products.length;
        products = products.filter(p => {
            const match = p.id !== id && p.id != id && String(p.id) !== String(id);
            if (!match) {
                console.log('删除商品:', p);
            }
            return match;
        });
        
        console.log('删除后商品列表:', products.length, '条', '删除了:', initialLength - products.length, '条');
        
        saveProducts();
        updateProductList();
        updateChart();
        
        // 取消自动同步，仅通过手动点击按钮触发
    }
}

// 添加映射
function addMapping() {
    const barcode = document.getElementById('newBarcode').value;
    const productName = document.getElementById('newProductName').value;
    const addMappingBtn = document.getElementById('addMappingBtn');
    const isEditing = addMappingBtn.dataset.editingId;
    
    if (!barcode || !productName) {
        alert('请填写完整的条码和商品名称！');
        return;
    }
    
    if (isEditing) {
        // 编辑模式: 更新现有映射
        // 不再使用parseInt，保持id的原始类型（可能是字符串或数字）
        const mappingId = isEditing;
        const mappingIndex = productMappings.findIndex(m => m.id == mappingId); // 使用==进行宽松比较
        if (mappingIndex !== -1) {
            const oldBarcode = productMappings[mappingIndex].barcode;
            productMappings[mappingIndex] = {
                ...productMappings[mappingIndex],
                barcode: barcode,
                productName: productName
            };
            // 如果条码发生变化，需要更新商品列表中所有使用旧条码的商品名称
            if (oldBarcode !== barcode) {
                syncProductNames(oldBarcode, productName);
            }
            // 同步更新使用新条码的商品名称
            syncProductNames(barcode, productName);
            
            saveMappings();
            updateMappingList();
            updateProductList();
            
            // 清空输入
            document.getElementById('newBarcode').value = '';
            document.getElementById('newProductName').value = '';
            
            // 重置编辑模式
            delete addMappingBtn.dataset.editingId;
            addMappingBtn.textContent = '添加映射';
            
            // 取消自动同步，仅通过手动点击按钮触发
            
            alert('映射更新成功！');
        }
    } else {
        // 添加模式: 创建新映射或更新现有映射
        const existingIndex = productMappings.findIndex(m => m.barcode === barcode);
        
        if (existingIndex >= 0) {
            // 更新现有映射
            productMappings[existingIndex].productName = productName;
            // 同步更新商品列表中的商品名称
            syncProductNames(barcode, productName);
        } else {
            // 添加新映射
            productMappings.push({
                id: Date.now(),
                barcode: barcode,
                productName: productName
            });
        }
        
        // 保存映射
        saveMappings();
        
        // 更新映射列表
        updateMappingList();
        
        // 清空输入
        document.getElementById('newBarcode').value = '';
        document.getElementById('newProductName').value = '';
        
        // 自动同步到云端
        if (APP_ID !== 'your_app_id' && APP_KEY !== 'your_app_key') {
            console.log('自动同步映射数据到云端...');
            realSyncData();
        }
        
        alert('映射保存成功！');
    }
}

// 同步商品名称
function syncProductNames(barcode, newName) {
    products.forEach(product => {
        if (product.barcode === barcode) {
            product.productName = newName;
        }
    });
    saveProducts();
    updateProductList();
}

// 更新映射列表
function updateMappingList() {
    const tbody = document.querySelector('#mappingTable tbody');
    tbody.innerHTML = '';
    
    productMappings.forEach((mapping, index) => {
        const row = document.createElement('tr');
        
        row.innerHTML = `
            <td>${index + 1}</td>
            <td>${mapping.barcode}</td>
            <td>${mapping.productName}</td>
            <td>
                <button class="btn btn-secondary" onclick="editMapping('${mapping.id}')">编辑</button>
                <button class="btn btn-danger" onclick="deleteMapping('${mapping.id}')">删除</button>
            </td>
        `;
        
        tbody.appendChild(row);
    });
}

// 编辑映射（全局函数，以便HTML onclick事件调用）
window.editMapping = function(id) {
    console.log('editMapping函数被调用，id:', id, '类型:', typeof id);
    console.log('当前映射列表:', productMappings.map(m => ({ id: m.id, type: typeof m.id })));
    
    // 尝试使用不同的比较方式查找映射
    let mapping = productMappings.find(m => m.id === id);
    console.log('使用===查找结果:', mapping);
    
    if (!mapping) {
        mapping = productMappings.find(m => m.id == id);
        console.log('使用==查找结果:', mapping);
    }
    
    if (!mapping) {
        mapping = productMappings.find(m => String(m.id) === String(id));
        console.log('使用字符串转换查找结果:', mapping);
    }
    if (!mapping) {
        console.log('未找到映射，id:', id);
        return;
    }
    
    try {
        document.getElementById('newBarcode').value = mapping.barcode;
        document.getElementById('newProductName').value = mapping.productName;
        
        // 设置编辑模式
        document.getElementById('addMappingBtn').dataset.editingId = id;
        document.getElementById('addMappingBtn').textContent = '更新映射';
        
        console.log('映射编辑功能执行成功');
    } catch (error) {
        console.error('映射编辑功能执行失败:', error);
    }
}

// 删除映射（全局函数，以便HTML onclick事件调用）
window.deleteMapping = function(id) {
    if (confirm('确定要删除这个映射吗？')) {
        // 使用==进行宽松比较，兼容字符串和数字类型的ID
        productMappings = productMappings.filter(m => m.id != id);
        saveMappings();
        updateMappingList();
        
        // 取消自动同步，仅通过手动点击按钮触发
    }
}

// 导出CSV
function exportToCSV() {
    if (products.length === 0) {
        alert('没有数据可以导出！');
        return;
    }
    
    // 使用用户要求的表头顺序
    const headers = ['类型', '商品条码', '商品名称', '扫描日期', '有效期', '生产日期', '保质期(月)', '状态'];
    const rows = products.map(product => [
        product.type,
        product.barcode,
        product.productName,
        product.scanDate,
        product.validity,
        product.productionDate || '',
        product.shelfLife || '',
        getStatusText(getExpiryStatus(product.validity))
    ]);
    
    const csvContent = [
        headers.join(','),
        ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    link.setAttribute('href', url);
    link.setAttribute('download', `商品到期提醒_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// 导入CSV
function importFromCSV(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(event) {
        const csvContent = event.target.result;
        const rows = csvContent.split('\n').filter(row => row.trim());
        
        if (rows.length < 2) {
            alert('CSV文件格式不正确！');
            return;
        }
        
        let productCount = 0;
        let mappingCount = 0;
        
        // 跳过表头，按照用户要求的顺序解析: 类型、商品条码、商品名称、扫描日期、有效期、生产日期、保质期(月)
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i].split(',').map(cell => cell.replace(/"/g, ''));
            if (row.length >= 3) {
                const type = row[0].trim();
                const barcode = row[1].trim();
                const productName = row[2].trim();
                
                if (type === '商品' && row.length >= 7) {
                    // 导入商品数据
                    const product = {
                        id: Date.now() + i,
                        type: type,
                        barcode: barcode,
                        productName: productName,
                        scanDate: row[3] || '',
                        validity: row[4] || '',
                        productionDate: row[5] || '',
                        shelfLife: row[6] || '',
                        createdAt: new Date().toISOString()
                    };
                    products.push(product);
                    productCount++;
                } else if (type === '映射') {
                    // 导入映射数据
                    const mapping = {
                        id: Date.now() + i + 1000, // 确保ID与商品不冲突
                        barcode: barcode,
                        productName: productName
                    };
                    // 检查是否已存在相同条码的映射
                    const existingIndex = productMappings.findIndex(m => m.barcode === barcode);
                    if (existingIndex >= 0) {
                        productMappings[existingIndex] = mapping;
                    } else {
                        productMappings.push(mapping);
                    }
                    mappingCount++;
                }
            }
        }
        
        saveProducts();
        saveMappings();
        updateProductList();
        updateMappingList();
        updateChart();
        
        alert(`成功导入 ${productCount} 条商品记录和 ${mappingCount} 条映射记录！`);
    };
    
    reader.readAsText(file, 'UTF-8');
    
    // 重置文件输入
    e.target.value = '';
}

// 清空所有数据
function clearAllData() {
    if (confirm('确定要清空所有数据吗？此操作不可恢复！')) {
        products = [];
        productMappings = [];
        saveProducts();
        saveMappings();
        updateProductList();
        updateMappingList();
        updateChart();
        alert('所有数据已清空！');
    }
}

// 图表实例
let chart;

// 初始化图表
function initializeChart() {
    const ctx = document.getElementById('expiryChart').getContext('2d');
    chart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['正常', '1-3个月', '1个月内', '已过期'],
            datasets: [{
                label: '商品数量',
                data: getExpiryCounts(),
                backgroundColor: [
                    'rgba(76, 175, 80, 0.6)',
                    'rgba(255, 152, 0, 0.6)',
                    'rgba(244, 67, 54, 0.6)',
                    'rgba(158, 158, 158, 0.6)'
                ],
                borderColor: [
                    'rgba(76, 175, 80, 1)',
                    'rgba(255, 152, 0, 1)',
                    'rgba(244, 67, 54, 1)',
                    'rgba(158, 158, 158, 1)'
                ],
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        precision: 0
                    }
                }
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return `商品数量: ${context.raw}`;
                        }
                    }
                }
            }
        }
    });
}

// 获取到期数量统计
function getExpiryCounts() {
    const counts = {
        normal: 0,
        warning: 0,
        danger: 0,
        expired: 0
    };
    
    products.forEach(product => {
        const status = getExpiryStatus(product.validity);
        counts[status]++;
    });
    
    return [counts.normal, counts.warning, counts.danger, counts.expired];
}

// 更新图表
function updateChart() {
    if (chart) {
        chart.data.datasets[0].data = getExpiryCounts();
        chart.update();
    }
}

// 加载数据
function loadData() {
    // 从本地存储加载
    products = JSON.parse(localStorage.getItem('products')) || [];
    productMappings = JSON.parse(localStorage.getItem('productMappings')) || [];
}

// 同步数据到 LeanCloud
function syncData() {
    // 检查是否使用默认配置
    const isDefaultConfig = APP_ID === 'your_app_id' || APP_KEY === 'your_app_key';
    
    console.log('syncData函数被调用，配置检查:', { APP_ID, APP_KEY, isDefaultConfig });
    
    if (isDefaultConfig) {
        // 使用模拟同步功能
        console.log('使用模拟同步功能');
        simulateSyncData();
    } else {
        // 使用实际的 LeanCloud 同步功能
        console.log('使用真实LeanCloud同步功能');
        realSyncData();
    }
}

// 模拟数据同步功能
function simulateSyncData() {
    console.log('开始模拟数据同步...');
    
    try {
        // 显示同步进度
        const syncNotification = document.createElement('div');
        syncNotification.style.position = 'fixed';
        syncNotification.style.top = '20px';
        syncNotification.style.right = '20px';
        syncNotification.style.backgroundColor = '#4CAF50';
        syncNotification.style.color = 'white';
        syncNotification.style.padding = '15px';
        syncNotification.style.borderRadius = '8px';
        syncNotification.style.boxShadow = '0 4px 8px rgba(0,0,0,0.1)';
        syncNotification.style.zIndex = '1000';
        syncNotification.style.fontSize = '14px';
        syncNotification.textContent = '正在同步数据...';
        document.body.appendChild(syncNotification);
        
        // 模拟网络延迟
        setTimeout(() => {
            // 模拟同步商品数据
            console.log('模拟同步商品数据:', products.length, '条');
            
            // 模拟同步映射数据
            console.log('模拟同步映射数据:', productMappings.length, '条');
            
            // 更新通知
            syncNotification.textContent = '数据同步完成！';
            syncNotification.style.backgroundColor = '#45a049';
            
            // 3秒后移除通知
            setTimeout(() => {
                document.body.removeChild(syncNotification);
            }, 3000);
            
            // 显示同步结果
            alert(`模拟数据同步完成！\n商品数据: ${products.length}条\n映射数据: ${productMappings.length}条\n\n提示: 要使用真实的LeanCloud同步功能，请在script.js文件中配置你的APP_ID、APP_KEY和serverURL。`);
            
        }, 1500);
        
    } catch (error) {
        console.error('模拟同步失败:', error);
        alert('模拟数据同步失败: ' + error.message);
    }
}

// 实际的 LeanCloud 同步功能
function realSyncData() {
    if (!APP_ID || !APP_KEY) {
        alert('请先配置 LeanCloud App ID 和 App Key！');
        return;
    }
    
    console.log('开始使用真实 LeanCloud 同步数据...');
    console.log('配置信息:', { APP_ID, APP_KEY, serverURL: AV.serverURL });
    
    // 显示同步进度通知
    const syncNotification = document.createElement('div');
    syncNotification.style.position = 'fixed';
    syncNotification.style.top = '20px';
    syncNotification.style.right = '20px';
    syncNotification.style.backgroundColor = '#4CAF50';
    syncNotification.style.color = 'white';
    syncNotification.style.padding = '15px';
    syncNotification.style.borderRadius = '8px';
    syncNotification.style.boxShadow = '0 4px 8px rgba(0,0,0,0.1)';
    syncNotification.style.zIndex = '1000';
    syncNotification.style.fontSize = '14px';
    syncNotification.textContent = '正在同步数据到 LeanCloud...';
    document.body.appendChild(syncNotification);
    
    let totalSyncCount = 0;
    let successfulSyncCount = 0;
    let failedSyncCount = 0;
    
    const totalItems = products.length + productMappings.length;
    
    if (totalItems === 0) {
        syncNotification.textContent = '没有数据需要同步！';
        setTimeout(() => {
            document.body.removeChild(syncNotification);
        }, 3000);
        alert('没有数据需要同步！');
        return;
    }
    
    // 更新同步进度
    function updateSyncProgress() {
        syncNotification.textContent = `正在同步数据: ${totalSyncCount}/${totalItems} (成功: ${successfulSyncCount}, 失败: ${failedSyncCount})`;
    }
    
    // 完成同步
    function finishSync() {
        syncNotification.textContent = `数据同步完成: 共 ${totalItems} 项，成功 ${successfulSyncCount} 项，失败 ${failedSyncCount} 项`;
        
        // 根据结果显示不同的颜色
        if (failedSyncCount === 0) {
            syncNotification.style.backgroundColor = '#45a049'; // 成功
        } else {
            syncNotification.style.backgroundColor = '#ff9800'; // 警告
        }
        
        setTimeout(() => {
            document.body.removeChild(syncNotification);
        }, 5000);
        
        alert(`数据同步完成！\n共 ${totalItems} 项\n成功: ${successfulSyncCount} 项\n失败: ${failedSyncCount} 项`);
    }
    
    // 带节流和重试的请求处理函数
    function throttledRequest(item, processFn, delay = 1000, maxRetries = 3) {
        let retries = 0;
        
        function attemptRequest() {
            return new Promise((resolve, reject) => {
                setTimeout(() => {
                    processFn(item).then(resolve).catch(error => {
                        // 如果是429错误（请求频率过高），重试
                        if (error.code === 429 && retries < maxRetries) {
                            retries++;
                            const retryDelay = delay * Math.pow(2, retries); // 指数退避
                            console.log(`请求频率过高，${retries}秒后重试（第${retries}次重试）:`, item.barcode);
                            setTimeout(() => {
                                attemptRequest().then(resolve).catch(reject);
                            }, retryDelay * 1000);
                        } else {
                            reject(error);
                        }
                    });
                }, delay);
            });
        }
        
        return attemptRequest();
    }
    
    // 同步商品数据
    function syncProducts() {
        return new Promise((resolve) => {
            if (products.length === 0) {
                resolve();
                return;
            }
            
            console.log('开始同步商品数据，共', products.length, '条');
            
            let completed = 0;
            const delayBetweenRequests = 500; // 每次请求间隔500毫秒
            
            // 串行处理商品数据，避免请求频率过高
            function processNextProduct(index = 0) {
                if (index >= products.length) {
                    resolve();
                    return;
                }
                
                const product = products[index];
                const Product = AV.Object.extend('Product');
                const query = new AV.Query(Product);
                
                // 创建一个不包含保留字段的产品数据副本
                const productData = { ...product };
                delete productData.id; // 移除本地ID字段
                delete productData.createdAt; // 确保移除LeanCloud保留字段
                delete productData.updatedAt; // 确保移除LeanCloud保留字段
                
                // 处理单个商品的函数
                function processProduct() {
                    return new Promise((resolve, reject) => {
                        // 先检查是否已存在相同条码的商品
                        query.equalTo('barcode', productData.barcode);
                        query.first().then(existingProduct => {
                            let avProduct;
                            if (existingProduct) {
                                // 如果存在，更新现有记录
                                avProduct = existingProduct;
                                console.log('更新现有商品:', productData.barcode);
                            } else {
                                // 如果不存在，创建新记录
                                avProduct = new Product();
                                console.log('创建新商品:', productData.barcode);
                            }
                            
                            // 设置产品数据到AV对象
                            avProduct.set('barcode', productData.barcode);
                            avProduct.set('productName', productData.productName);
                            avProduct.set('type', productData.type);
                            avProduct.set('scanDate', productData.scanDate);
                            avProduct.set('productionDate', productData.productionDate);
                            avProduct.set('shelfLife', productData.shelfLife);
                            avProduct.set('validity', productData.validity);
                            
                            // 保存到 LeanCloud
                            return avProduct.save();
                        }).then(resolve).catch(reject);
                    });
                }
                
                // 使用节流处理请求
                throttledRequest(product, processProduct, delayBetweenRequests / 1000).then(
                    () => {
                        console.log('商品数据同步成功:', productData.barcode);
                        successfulSyncCount++;
                        totalSyncCount++;
                        updateSyncProgress();
                    },
                    error => {
                        console.error('商品数据同步失败:', productData.barcode, error);
                        failedSyncCount++;
                        totalSyncCount++;
                        updateSyncProgress();
                    }
                ).finally(() => {
                    completed++;
                    // 处理下一个商品
                    processNextProduct(index + 1);
                });
            }
            
            // 开始处理第一个商品
            processNextProduct();
        });
    }
    
    // 同步映射数据
    function syncMappings() {
        return new Promise((resolve) => {
            if (productMappings.length === 0) {
                resolve();
                return;
            }
            
            console.log('开始同步映射数据，共', productMappings.length, '条');
            
            let completed = 0;
            const delayBetweenRequests = 500; // 每次请求间隔500毫秒
            
            // 串行处理映射数据，避免请求频率过高
            function processNextMapping(index = 0) {
                if (index >= productMappings.length) {
                    resolve();
                    return;
                }
                
                const mapping = productMappings[index];
                const Mapping = AV.Object.extend('Mapping');
                const query = new AV.Query(Mapping);
                
                // 创建一个不包含保留字段的映射数据副本
                const mappingData = { ...mapping };
                delete mappingData.id; // 移除本地ID字段
                delete mappingData.createdAt; // 确保移除LeanCloud保留字段
                delete mappingData.updatedAt; // 确保移除LeanCloud保留字段
                
                // 处理单个映射的函数
                function processMapping() {
                    return new Promise((resolve, reject) => {
                        // 先检查是否已存在相同条码的映射
                        query.equalTo('barcode', mappingData.barcode);
                        query.first().then(existingMapping => {
                            let avMapping;
                            if (existingMapping) {
                                // 如果存在，更新现有记录
                                avMapping = existingMapping;
                                console.log('更新现有映射:', mappingData.barcode);
                            } else {
                                // 如果不存在，创建新记录
                                avMapping = new Mapping();
                                console.log('创建新映射:', mappingData.barcode);
                            }
                            
                            avMapping.set('barcode', mappingData.barcode);
                            avMapping.set('productName', mappingData.productName);
                            
                            // 保存到 LeanCloud
                            return avMapping.save();
                        }).then(resolve).catch(reject);
                    });
                }
                
                throttledRequest(mapping, processMapping, delayBetweenRequests / 1000).then(
                    () => {
                        console.log('映射数据同步成功:', mappingData.barcode);
                        successfulSyncCount++;
                        totalSyncCount++;
                        updateSyncProgress();
                    },
                    error => {
                        console.error('映射数据同步失败:', mappingData.barcode, error);
                        failedSyncCount++;
                        totalSyncCount++;
                        updateSyncProgress();
                    }
                ).finally(() => {
                    completed++;
                    // 处理下一个映射
                    processNextMapping(index + 1);
                });
            }
            
            // 开始处理第一个映射
            processNextMapping();
        });
    }
    
    // 执行同步
    try {
        // 先同步商品数据，再同步映射数据
        syncProducts().then(() => {
            return syncMappings();
        }).then(() => {
            // 同步完成
            finishSync();
        }).catch(error => {
            console.error('数据同步过程中发生错误:', error);
            syncNotification.textContent = '数据同步发生错误！';
            syncNotification.style.backgroundColor = '#f44336'; // 错误
            
            setTimeout(() => {
                document.body.removeChild(syncNotification);
            }, 5000);
            
            let errorMsg = '数据同步失败: ' + error.message;
            
            // 针对API域名白名单错误提供更具体的解决方案
            if (error.message.includes('Access denied by api domain white list')) {
                const origin = error.message.match(/request origin header is '(.*?)'/);
                if (origin && origin[1]) {
                    errorMsg += `\n\n解决方案：\n1. 登录 LeanCloud 控制台\n2. 进入应用设置 > 安全中心 > Web安全域名\n3. 在输入框中添加：${origin[1]}\n4. 点击保存后重新尝试`;
                }
            }
            
            alert(errorMsg);
        });
    } catch (error) {
        console.error('数据同步初始化失败:', error);
        syncNotification.textContent = '数据同步发生错误！';
        syncNotification.style.backgroundColor = '#f44336'; // 错误
        
        setTimeout(() => {
            document.body.removeChild(syncNotification);
        }, 5000);
        
        let errorMsg = '数据同步失败: ' + error.message;
        
        // 针对API域名白名单错误提供更具体的解决方案
        if (error.message.includes('Access denied by api domain white list')) {
            const origin = error.message.match(/request origin header is '(.*?)'/);
            if (origin && origin[1]) {
                errorMsg += `\n\n解决方案：\n1. 登录 LeanCloud 控制台\n2. 进入应用设置 > 应用 Keys\n3. 在 API 域名白名单中添加：${origin[1]}\n4. 保存设置后重新尝试`;
            }
        }
        
        alert(errorMsg);
    }
}

// 从 LeanCloud 获取最新数据
window.fetchLatestDataFromCloud = function() {
    console.log('开始从LeanCloud获取最新数据...');
    
    // 显示获取数据进度通知
    const fetchNotification = document.createElement('div');
    fetchNotification.style.position = 'fixed';
    fetchNotification.style.top = '20px';
    fetchNotification.style.right = '20px';
    fetchNotification.style.backgroundColor = '#2196F3';
    fetchNotification.style.color = 'white';
    fetchNotification.style.padding = '15px';
    fetchNotification.style.borderRadius = '8px';
    fetchNotification.style.boxShadow = '0 4px 8px rgba(0,0,0,0.1)';
    fetchNotification.style.zIndex = '1000';
    fetchNotification.style.fontSize = '14px';
    fetchNotification.textContent = '正在从云端获取最新数据...';
    document.body.appendChild(fetchNotification);
    
    // 获取商品数据
    function fetchProducts() {
        return new Promise((resolve, reject) => {
            const Product = AV.Object.extend('Product');
            const query = new AV.Query(Product);
            
            query.find().then(results => {
                console.log('成功获取到商品数据:', results.length, '条');
                const cloudProducts = results.map(item => {
                    return {
                        id: item.id, // 使用LeanCloud的objectId作为唯一标识
                        barcode: item.get('barcode'),
                        productName: item.get('productName'),
                        type: item.get('type'),
                        scanDate: item.get('scanDate'),
                        productionDate: item.get('productionDate'),
                        shelfLife: item.get('shelfLife'),
                        validity: item.get('validity'),
                        createdAt: item.createdAt.toISOString(),
                        updatedAt: item.updatedAt.toISOString()
                    };
                });
                resolve(cloudProducts);
            }).catch(error => {
                console.error('获取商品数据失败:', error);
                reject(error);
            });
        });
    }
    
    // 获取映射数据
    function fetchMappings() {
        return new Promise((resolve, reject) => {
            const Mapping = AV.Object.extend('Mapping');
            const query = new AV.Query(Mapping);
            
            query.find().then(results => {
                console.log('成功获取到映射数据:', results.length, '条');
                const cloudMappings = results.map(item => {
                    return {
                        id: item.id, // 使用LeanCloud的objectId作为唯一标识
                        barcode: item.get('barcode'),
                        productName: item.get('productName'),
                        createdAt: item.createdAt.toISOString(),
                        updatedAt: item.updatedAt.toISOString()
                    };
                });
                resolve(cloudMappings);
            }).catch(error => {
                console.error('获取映射数据失败:', error);
                reject(error);
            });
        });
    }
    
    // 合并数据
    function mergeData(cloudProducts, cloudMappings) {
        console.log('开始合并数据...');
        
        // 合并商品数据（使用云端数据覆盖本地数据）
        if (cloudProducts.length > 0) {
            products = cloudProducts;
            saveProducts();
            updateProductList();
            updateChart();
        }
        
        // 合并映射数据（使用云端数据覆盖本地数据）
        if (cloudMappings.length > 0) {
            productMappings = cloudMappings;
            saveMappings();
            updateMappingList();
        }
        
        console.log('数据合并完成:', { products: products.length, mappings: productMappings.length });
        
        fetchNotification.textContent = '数据获取完成！共获取 ' + (cloudProducts.length + cloudMappings.length) + ' 项数据';
        fetchNotification.style.backgroundColor = '#45a049'; // 成功
        
        setTimeout(() => {
            document.body.removeChild(fetchNotification);
        }, 5000);
        
        alert(`成功从云端获取最新数据！\n商品: ${cloudProducts.length} 条\n映射: ${cloudMappings.length} 条`);
    }
    
    // 执行数据获取
    fetchProducts().then(cloudProducts => {
        return fetchMappings().then(cloudMappings => {
            mergeData(cloudProducts, cloudMappings);
        });
    }).catch(error => {
        console.error('数据获取过程中发生错误:', error);
        fetchNotification.textContent = '数据获取发生错误！';
        fetchNotification.style.backgroundColor = '#f44336'; // 错误
        
        setTimeout(() => {
            document.body.removeChild(fetchNotification);
        }, 5000);
        
        let errorMsg = '数据获取失败: ' + error.message;
        
        // 针对API域名白名单错误提供更具体的解决方案
        if (error.message.includes('Access denied by api domain white list')) {
            const origin = error.message.match(/request origin header is '(.*?)'/);
            if (origin && origin[1]) {
                errorMsg += `\n\n解决方案：\n1. 登录 LeanCloud 控制台\n2. 进入应用设置 > 安全中心 > Web安全域名\n3. 在输入框中添加：${origin[1]}\n4. 点击保存后重新尝试`;
            }
        }
        
        alert(errorMsg);
    });
}

// 初始化实时数据监听
function initializeLiveQuery() {
    console.log('开始初始化实时数据监听...');
    
    // 检查是否使用默认配置
    const isDefaultConfig = APP_ID === 'your_app_id' || APP_KEY === 'your_app_key';
    if (isDefaultConfig) {
        console.log('使用默认配置，跳过实时数据监听初始化');
        return;
    }
    
    try {
        // 检查 LiveQuery 是否可用
        if (!AV.LiveQuery || !AV.LiveQuery.subscribe) {
            console.log('当前 LeanCloud SDK 不支持 LiveQuery 功能');
            // 不再自动设置定期同步，只保留手动同步
            return;
        }
        
        // 初始化商品数据监听
        const Product = AV.Object.extend('Product');
        const productQuery = new AV.Query(Product);
        
        // 订阅商品数据变更
        AV.LiveQuery.subscribe(productQuery).then(productSubscription => {
            console.log('成功订阅商品数据变更');
            
            // 处理商品创建事件
            productSubscription.on('create', function(product) {
                console.log('收到商品创建事件:', product.get('barcode'));
                showRealTimeNotification('新商品添加', `${product.get('productName')} (${product.get('barcode')}) 已添加`);
            });
            
            // 处理商品更新事件
            productSubscription.on('update', function(product) {
                console.log('收到商品更新事件:', product.get('barcode'));
                showRealTimeNotification('商品更新', `${product.get('productName')} (${product.get('barcode')}) 已更新`);
            });
            
            // 处理商品删除事件
            productSubscription.on('delete', function(product) {
                console.log('收到商品删除事件:', product.get('barcode'));
                showRealTimeNotification('商品删除', `${product.get('productName')} (${product.get('barcode')}) 已删除`);
            });
        }).catch(error => {
            console.error('订阅商品数据变更失败:', error);
            // 不再自动设置定期同步
        });
        
        // 初始化映射数据监听
        const Mapping = AV.Object.extend('Mapping');
        const mappingQuery = new AV.Query(Mapping);
        
        // 订阅映射数据变更
        AV.LiveQuery.subscribe(mappingQuery).then(mappingSubscription => {
            console.log('成功订阅映射数据变更');
            
            // 处理映射创建事件
            mappingSubscription.on('create', function(mapping) {
                console.log('收到映射创建事件:', mapping.get('barcode'));
                showRealTimeNotification('映射添加', `条码 ${mapping.get('barcode')} 映射到 ${mapping.get('productName')} 已添加`);
            });
            
            // 处理映射更新事件
            mappingSubscription.on('update', function(mapping) {
                console.log('收到映射更新事件:', mapping.get('barcode'));
                showRealTimeNotification('映射更新', `条码 ${mapping.get('barcode')} 映射到 ${mapping.get('productName')} 已更新`);
            });
            
            // 处理映射删除事件
            mappingSubscription.on('delete', function(mapping) {
                console.log('收到映射删除事件:', mapping.get('barcode'));
                showRealTimeNotification('映射删除', `条码 ${mapping.get('barcode')} 的映射已删除`);
            });
        }).catch(error => {
            console.error('订阅映射数据变更失败:', error);
            // 不再自动设置定期同步
        });
        
        console.log('实时数据监听初始化完成');
        
    } catch (error) {
        console.error('初始化实时数据监听失败:', error);
        // 不再自动设置定期同步
    }
}

// 设置定期同步（作为LiveQuery的替代方案）
function setupPeriodicSync(interval = 30000) {
    console.log('设置定期同步机制');
    
    // 清除可能存在的旧定时器
    if (window.periodicSyncInterval) {
        clearInterval(window.periodicSyncInterval);
    }
    
    // 设置新的定时器
    window.periodicSyncInterval = setInterval(() => {
        console.log('定期同步数据中...');
        fetchLatestDataFromCloud();
    }, interval);
    
    // 显示通知
    showRealTimeNotification('定期同步已启动', `应用将每 ${interval / 1000} 秒自动同步云端数据`);
}

// 显示实时数据通知
function showRealTimeNotification(title, message) {
    const notification = document.createElement('div');
    notification.style.position = 'fixed';
    notification.style.top = '20px';
    notification.style.left = '50%';
    notification.style.transform = 'translateX(-50%)';
    notification.style.backgroundColor = '#2196F3';
    notification.style.color = 'white';
    notification.style.padding = '12px 20px';
    notification.style.borderRadius = '8px';
    notification.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
    notification.style.zIndex = '2000';
    notification.style.fontSize = '14px';
    notification.style.transition = 'all 0.3s ease';
    notification.style.maxWidth = '80%';
    notification.innerHTML = `<strong>${title}:</strong> ${message}`;
    
    document.body.appendChild(notification);
    
    // 3秒后自动移除通知
    setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transform = 'translateX(-50%) translateY(-20px)';
        setTimeout(() => {
            if (document.body.contains(notification)) {
                document.body.removeChild(notification);
            }
        }, 300);
    }, 3000);
}