'use strict';

/*
 * site —— 页面本身的托管（HTTP 访问服务）
 *
 * 背景：2026-09-16 起，本环境的默认域名会在**所有成功回源的响应**上追加
 * `Content-Disposition: attachment`，浏览器打开 index.html 会变成下载文件。
 * 静态托管和云函数 HTTP 访问服务都一样，而且平台会覆盖函数自己写的 `inline`，
 * 控制台也没有相关开关（详见 README「页面入口与默认域名的坑」）。
 * 所以现在正式的页面入口是 GitHub Pages，这个函数是**备份入口**：
 * 等绑了自定义域名、或平台策略解除后，它就能顶上（响应头完全由我们自己控制）。
 *
 * 页面里所有资源地址都是相对路径，所以在哪个路径前缀下都能正常跑：
 *   /app/            → index.html
 *   /app/styles.css  → 静态文件
 *   /app/shared/*.js → 共享模块
 *
 * 页面文件由 scripts/deploy.ps1 从项目根目录复制到 ./public/（该目录已 gitignore）。
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PREFIX = (process.env.SITE_PREFIX || '/app').replace(/\/+$/, '');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
};

// 只能这样返回二进制（HTTP 访问服务会把 body 当文本处理）
const BINARY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.woff', '.woff2'];

function respond(statusCode, headers, body, isBase64) {
    return {
        statusCode: statusCode,
        headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, headers),
        body: body === undefined ? '' : body,
        isBase64Encoded: !!isBase64
    };
}

exports.main = async (event) => {
    const ev = event || {};
    const method = (ev.httpMethod || ev.method || 'GET').toUpperCase();

    if (method === 'OPTIONS') return respond(204, {}, '');
    if (method !== 'GET' && method !== 'HEAD') {
        return respond(405, {}, '只支持 GET');
    }

    const filePath = resolveFilePath(ev.path);
    if (!filePath) {
        return respond(404, { 'Content-Type': 'text/html; charset=utf-8' }, notFoundPage());
    }

    let content;
    try {
        content = fs.readFileSync(filePath);
    } catch (error) {
        console.error('读取文件失败:', filePath, error.message);
        return respond(404, { 'Content-Type': 'text/html; charset=utf-8' }, notFoundPage());
    }

    const ext = path.extname(filePath).toLowerCase();
    const isHtml = ext === '.html';
    const headers = {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        // 页面本身不缓存（否则改了发不出去），带 ?v= 的资源可以长期缓存
        'Cache-Control': isHtml ? 'no-cache, must-revalidate' : 'public, max-age=31536000',
        // 显式声明「在线打开」：默认域名回源时平台会追加 attachment，
        // 这里主动写 inline，指望浏览器优先采纳前一个（在多个同名头时的常见行为）
        'Content-Disposition': 'inline',
        'X-Served-By': 'cloudbase-function-site'
    };

    if (method === 'HEAD') {
        headers['Content-Length'] = content.length;
        return respond(200, headers, '');
    }

    const binary = BINARY_EXTENSIONS.indexOf(ext) >= 0;
    return respond(200, headers, binary ? content.toString('base64') : content.toString('utf-8'), binary);
};

// 把请求路径映射到 public 下的真实文件；越界或不存在返回 null
function resolveFilePath(requestPath) {
    let urlPath = String(requestPath || '/');

    try {
        urlPath = decodeURIComponent(urlPath);
    } catch (e) {
        return null;
    }

    // HTTP 访问服务会把前缀（如 /app）也带进来，这里去掉
    if (PREFIX && urlPath.indexOf(PREFIX) === 0) urlPath = urlPath.slice(PREFIX.length);
    if (urlPath.indexOf('?') >= 0) urlPath = urlPath.slice(0, urlPath.indexOf('?'));
    if (!urlPath || urlPath === '/') urlPath = '/index.html';
    if (urlPath.slice(-1) === '/') urlPath += 'index.html';

    const relative = path.normalize(urlPath).replace(/^([/\\])+/, '');
    const full = path.join(PUBLIC_DIR, relative);

    // 防目录穿越：解析后的路径必须仍在 public 目录里
    if (full.indexOf(PUBLIC_DIR) !== 0) return null;
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;

    return full;
}

function notFoundPage() {
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
        + '<title>页面不存在</title></head><body style="font-family:sans-serif;padding:24px">'
        + '<h2>404 页面不存在</h2>'
        + '<p>访问入口是 <a href="' + (PREFIX || '') + '/">' + (PREFIX || '') + '/</a></p>'
        + '</body></html>';
}
