/* ハタボ（ホーム画面のウェブアプリ）の通知係：伝言が届いたら通知とアイコンの数字。押したら伝言をひらく */
'use strict';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  const jobs = [self.registration.showNotification(d.title || 'ハタボ', {
    body: d.body || '伝言が届いています',
    icon: 'https://www.hatha-lab.com/icon-192.png',
    tag: d.tag || 'inbox',
    renotify: true,
    data: { url: d.url || '', page: d.page || 'inbox' }
  })];
  const nav = self.navigator;
  if (typeof d.badge === 'number' && nav && nav.setAppBadge) jobs.push(d.badge > 0 ? nav.setAppBadge(d.badge) : nav.clearAppBadge());
  e.waitUntil(Promise.all(jobs).catch(() => {}));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const scope = self.registration.scope, d = e.notification.data || {};
  const url = String(d.url || '').startsWith(scope) ? d.url : scope + '?page=' + (d.page || 'inbox');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) if (c.url.startsWith(scope)) { c.postMessage({ type: 'open', page: d.page || 'inbox' }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
