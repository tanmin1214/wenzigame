/* 文字游戏工坊（手机版）— Service Worker
   作用：让页面可「安装到主屏幕」，并缓存界面外壳，断网也能打开。
   ⚠️ 规则书与对话都存在浏览器本地（IndexedDB / localStorage），不经过网络。
   用相对路径，方便挂在任意子目录下。
*/
'use strict';

const VERSION = 'gwm-v25';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './protocol-default.js',
  './docx-browser.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => undefined))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 大模型接口不拦截（跨域，交给浏览器直连）
  if (url.origin !== self.location.origin) return;

  // 导航：网络优先，断网回落外壳
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('./index.html').then((r) => r || Response.error()))
    );
    return;
  }

  // 静态资源：网络优先（保证网站一更新手机上立刻生效），断网时回落缓存。
  // 之前是「缓存优先 + 后台更新」，结果更新完要刷新两次才看到新版本，容易让人以为没生效。
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => undefined);
      }
      return res;
    }).catch(() => caches.match(req).then((r) => r || Response.error()))
  );
});
