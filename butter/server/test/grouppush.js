// グループのIDを残す（入ったとき・発言のとき）、管理画面とAPIからグループに送る、送信数の残り
'use strict';
const assert = require('assert'), crypto = require('crypto'), http = require('http');
process.env.HATABO_CHANNEL_SECRET = 'sec'; process.env.HATABO_LINE_TOKEN = 'tok'; process.env.CLAUDE_FAMILY = '0'; process.env.CRON_KEY = 'cron-key-1';
const pushed = [], realFetch = global.fetch;
global.fetch = async (url, opt) => {
  url = String(url);
  if (url.startsWith('https://api.line.me/')) {
    if (/\/summary$/.test(url)) return { ok: true, json: async () => ({ groupName: 'ハタボ開発チーム' }) };
    if (/members\/count$/.test(url)) return { ok: true, json: async () => ({ count: 3 }) };
    if (/quota\/consumption$/.test(url)) return { ok: true, json: async () => ({ totalUsage: 40 }) };
    if (/message\/quota$/.test(url)) return { ok: true, json: async () => ({ type: 'limited', value: 200 }) };
    if (/message\/push$/.test(url)) { pushed.push(JSON.parse(opt.body)); return { ok: true, json: async () => ({}) }; }
    return { ok: true, json: async () => ({ displayName: 'ほくと' }) };
  }
  return realFetch(url, opt);
};
const { createServer, deps, groupsOut } = require('../server.js'); deps.db = false;
const post = (port, events) => new Promise((ok, ng) => {
  const raw = JSON.stringify({ events }), sig = crypto.createHmac('sha256', 'sec').update(raw).digest('base64');
  const r = http.request({ port, path: '/line/webhook', method: 'POST', headers: { 'x-line-signature': sig, 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', () => setTimeout(ok, 150)); });
  r.on('error', ng); r.end(raw);
});
(async () => {
  const server = createServer().listen(0), port = server.address().port, B = 'http://127.0.0.1:' + port;
  await post(port, [{ type: 'message', replyToken: 'r1', source: { type: 'group', groupId: 'Cabc123', userId: 'Uhokuto' }, message: { type: 'text', text: '声がプツプツ切れます' } }]);
  const G = await groupsOut();
  assert.ok(G.length === 1 && G[0].gid === 'Cabc123' && G[0].name === 'ハタボ開発チーム' && G[0].members === 3 && G[0].ch === 'hatabo' && G[0].lastAt, '発言でグループのIDと名前・人数を残す');
  assert.strictEqual((await fetch(B + '/admin/groups')).status, 403, '合言葉がないと断る');
  const L = await (await fetch(B + '/admin/groups', { headers: { 'X-Hatabo-Key': 'cron-key-1' } })).json();
  assert.ok(L.groups[0].gid === 'Cabc123' && L.quota.hatabo.left === 160, '一覧と送信数の残り');
  const P = await (await fetch(B + '/admin/group-push', { method: 'POST', headers: { 'X-Hatabo-Key': 'cron-key-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ gid: 'Cabc123', text: '北斗さん、ありがとうございます！' }) })).json();
  assert.ok(P.ok && pushed[0].to === 'Cabc123' && pushed[0].messages[0].text.startsWith('北斗さん'), 'グループに送れる');
  const N = await (await fetch(B + '/admin/group-push', { method: 'POST', headers: { 'X-Hatabo-Key': 'cron-key-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ gid: 'Cnone', text: 'x' }) })).json();
  assert.ok(!N.ok && /見つかりません/.test(N.error), '知らないグループには送らない');
  console.log('OK：グループのIDを残す・一覧・送信数の残り・グループに送る'); server.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
