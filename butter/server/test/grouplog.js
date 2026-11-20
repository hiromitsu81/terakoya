// グループのやりとり：記録中の発言とハタボの返事を保存、トーク一覧は管理者と事務局だけ、LINEのIDは出さない
'use strict';
process.env.HATABO_CHANNEL_SECRET = 'sec'; process.env.HATABO_LINE_TOKEN = 'tok';
const crypto = require('crypto'), realFetch = global.fetch;
global.fetch = async (url, opt) => { url = String(url); if (url.startsWith('https://api.line.me/')) { if (/\/member\/|\/profile\//.test(url)) return { ok: true, json: async () => ({ displayName: 'たろう' }) }; return { ok: true, json: async () => ({}) }; } return realFetch(url, opt); };
const http = require('http'), assert = require('assert'), WebSocket = require('ws'), { EventEmitter } = require('events');
const U = c => 'g:U' + c.repeat(32);
const gasSrv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
  const j = JSON.parse(b); res.setHeader('Content-Type', 'application/json');
  const who = { own: ['a', 'ヒロ'], vis: ['b', 'たろう'], off: ['c', '事務局'] }[j.idToken];
  if (j.action === 'brain' && who) return res.end(JSON.stringify({ ok: true, guest: true, owner: U(who[0]), me: who[1], role: '汎用', slots: [] }));
  res.end(JSON.stringify({ ok: true }));
}); }).listen(0);
process.env.GAS_URL = 'http://127.0.0.1:' + gasSrv.address().port;
process.env.OFFICE_OWNERS = 'U' + 'c'.repeat(32);
process.env.WEB_SECRET = 'x';
const { createServer, deps, saveCol } = require('../server.js');
let replyText = 'こんにちは。';
const fake = () => { const t = replyText; return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: t } }; yield { type: 'message_stop' }; }, finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }], usage: {} }) }; };
deps.claude = { messages: { stream: () => fake(), create: async () => ({ content: [{ type: 'text', text: '12月5日19時、4名さまでお待ちしております。' }], usage: {} }) } };
deps.tts = { synthesizeSpeech: async () => [{ audioContent: Buffer.from('x') }] };
deps.stt = { streamingRecognize: () => { const e = new EventEmitter(); e.write = () => {}; e.end = () => {}; return e; } };
deps.db = false;
function client(port, hello) { return new Promise((resolve, reject) => {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/talk'), msgs = [], waiters = [];
  ws.on('message', d => { const m = JSON.parse(d.toString()); msgs.push(m); waiters.slice().forEach(w => w(m)); });
  ws.on('open', () => { ws.send(JSON.stringify(hello)); resolve({ ws, msgs, send: o => ws.send(JSON.stringify(o)), until: (pred, ms = 4000) => new Promise((ok, ng) => { const t = setTimeout(() => ng(new Error('timeout')), ms); const w = m => { if (pred(m)) { clearTimeout(t); waiters.splice(waiters.indexOf(w), 1); ok(m); } }; waiters.push(w); }) }); });
  ws.on('error', reject); }); }
const talk = async (c, text) => { c.send({ type: 'text', text }); await c.until(m => m.type === 'reply_end', 6000); await new Promise(r => setTimeout(r, 150)); };
const post = (port, events) => new Promise((ok, ng) => {
  const raw = JSON.stringify({ events }), sig = crypto.createHmac('sha256', 'sec').update(raw).digest('base64');
  const r = http.request({ port, path: '/line/webhook', method: 'POST', headers: { 'x-line-signature': sig, 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', () => setTimeout(ok, 150)); });
  r.on('error', ng); r.end(raw);
});
(async () => {
  const server = createServer().listen(0), port = server.address().port;
  await saveCol('Cg9', 'groups', { gid: 'Cg9', name: '開発チーム', type: 'group', ch: 'hatabo', admin: 'U' + 'a'.repeat(32), rec: true, active: true, lastAt: Date.now() });
  const src = { type: 'group', groupId: 'Cg9', userId: 'U' + 'b'.repeat(32) };
  await post(port, [{ type: 'message', replyToken: 'r1', source: src, message: { id: 'm1', type: 'text', text: 'お弁当を12時に取りに行きます' } }]);
  await post(port, [{ type: 'message', replyToken: 'r2', source: src, message: { id: 'm2', type: 'text', text: 'ハタボって何？' } }]);
  const o = await client(port, { type: 'hello', idToken: 'own', app: 'hatabo' }); await o.until(m => m.type === 'ready');
  o.send({ type: 'groups_mine' }); const gm = await o.until(m => m.type === 'groups_mine');
  assert.ok(gm.list.length === 1 && gm.list[0].name === '開発チーム' && !('adminId' in gm.list[0]) && !JSON.stringify(gm).includes('Uaaaa'), '管理者のトーク一覧にグループ（LINEのIDは出さない）');
  o.send({ type: 'group_log', gid: 'Cg9' }); const gl = await o.until(m => m.type === 'group_log');
  assert.ok(gl.rec && gl.items.length >= 3 && /お弁当/.test(gl.items[0].text) && gl.items[0].name === 'たろう' && gl.items.some(x => x.bot), 'やりとりを文字で（ハタボの返事も）');
  const v = await client(port, { type: 'hello', idToken: 'vis', app: 'hatabo' }); await v.until(m => m.type === 'ready');
  v.send({ type: 'groups_mine' }); assert.strictEqual((await v.until(m => m.type === 'groups_mine')).list.length, 0, 'ほかの人には出ない');
  v.send({ type: 'group_log', gid: 'Cg9' }); assert.ok((await v.until(m => m.type === 'group_log')).denied, 'ほかの人は読めない');
  console.log('OK：グループのやりとり'); o.ws.close(); v.ws.close(); server.close(); gasSrv.close(); process.exit(0);
})().catch(e => { console.error('NG', e); process.exit(1); });
