/*
 * Service Worker —— 让页面可以「安装到主屏幕」并且断网也能打开。
 *
 * 缓存怎么分，取决于这个文件会不会频繁变。
 * 这里踩过一个真实的坑：腾讯云静态托管给 script.js / styles.css 的
 * Cache-Control 是 max-age=31536000（一年），改了代码不换地址就永远拿旧的，
 * 所以 index.html 里的资源地址都写成 ?v=日期。本文件的策略顺着这个约定来：
 *
 *   1. 页面本身（index.html）—— 先走网络，失败才用缓存。
 *      它里面写着各资源的 ?v= 版本号，必须最先拿到新的，
 *      否则会拿着过期的版本号去加载过期的脚本。
 *   2. 带 ?v= 的 js / css   —— 缓存优先。
 *      版本号一变就是新地址，自动绕过缓存去取新文件（这正是 ?v= 的意义），
 *      所以这里可以放心长期缓存，代价是「改了 css/js 必须记得换版本号」。
 *   3. 其他所有请求          —— 本文件一概不碰，直接交给网络。
 *      尤其是 GitHub API（读写 data.json）和 CloudBase 的请求：
 *      它们被缓存会让同步读到旧数据、或者写不进去。
 */

const VERSION = 'v1';                        // 改动本文件后请把这里加一，旧缓存会在 activate 里清掉
const CACHE_PREFIX = 'product-expiry-';
const PAGE_CACHE = CACHE_PREFIX + 'page-' + VERSION;
const ASSET_CACHE = CACHE_PREFIX + 'asset-' + VERSION;

// 安装时先存一份，保证「装完立刻断网」也能打开（jar 和 css 带版本号，运行中再补）
const SHELL_ASSETS = [
    './manifest.json',
    './icons/icon-180.png',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/maskable-512.png'
];

// 只拦 js / css 这类带版本号的静态资源；index.html 之外的同源文件（如 icons）走网络即可
const VERSIONED_ASSET = /\.(?:js|css)$/i;

self.addEventListener('install', function (event) {
    event.waitUntil((async function () {
        const assetCache = await caches.open(ASSET_CACHE);
        await Promise.all(SHELL_ASSETS.map(function (url) {
            // 某个文件 404 不该让整个安装失败
            return assetCache.add(url).catch(function () {});
        }));

        const pageCache = await caches.open(PAGE_CACHE);
        await pageCache.add('./').catch(function () {});

        await self.skipWaiting();   // 新版本立刻接管，不用等用户关掉所有标签页
    })());
});

self.addEventListener('activate', function (event) {
    event.waitUntil((async function () {
        const keys = await caches.keys();
        await Promise.all(keys.map(function (key) {
            const stale = key.indexOf(CACHE_PREFIX) === 0 &&
                          key !== PAGE_CACHE && key !== ASSET_CACHE;
            return stale ? caches.delete(key) : Promise.resolve();
        }));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', function (event) {
    const request = event.request;

    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // 跨域一律放行：GitHub API、CloudBase SDK、图片 CDN 都不能被这里缓存
    if (url.origin !== self.location.origin) return;

    if (request.mode === 'navigate') {
        event.respondWith(servePage(request));
        return;
    }

    if (VERSIONED_ASSET.test(url.pathname)) {
        event.respondWith(serveVersionedAsset(request));
    }
});

// 页面：网络优先，离线时回落到缓存
async function servePage(request) {
    const cache = await caches.open(PAGE_CACHE);
    try {
        // no-store：绕开静态托管自身的 HTTP 缓存（腾讯云 120 秒 / Pages 600 秒），
        // 保证「重新部署后打开就是新版」；离线时这里会抛错，转而用下面的缓存
        const response = await fetch(request, { cache: 'no-store' });
        if (response && response.ok) {
            cache.put('./', response.clone());
        }
        return response;
    } catch (error) {
        const cached = await cache.match('./');
        if (cached) return cached;
        throw error;
    }
}

// 带 ?v= 的静态资源：缓存优先，没命中才去网络并顺手存下
async function serveVersionedAsset(request) {
    const cache = await caches.open(ASSET_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;

    const response = await fetch(request);
    if (response && response.ok) {
        cache.put(request, response.clone());
    }
    return response;
}
