// 分身（オーナーが作る役割つきの窓口）と、事務局の管理画面
'use strict';
const http = require('http'), assert = require('assert'), WebSocket = require('ws'), { EventEmitter } = require('events');
const gasSrv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
  const j = JSON.parse(b); res.setHeader('Content-Type', 'application/json');
  if (j.action === 'brain') {
    if (j.idToken === 'own') return res.end(JSON.stringify({ ok: true, guest: true, owner: 'g:own', me: 'ヒロ', role: '汎用', slots: [] }));
    if (j.idToken === 'vis') return res.end(JSON.stringify({ ok: true, guest: true, owner: 'g:vis', me: 'ともだち', role: '汎用', slots: [] }));
  }
  res.end(JSON.stringify({ ok: true }));
}); }).listen(0);
process.env.GAS_URL = 'http://127.0.0.1:' + gasSrv.address().port;
process.env.OFFICE_OWNERS = 'own';
const { createServer, deps } = require('../server.js');
let lastSystem = '';
const fake = t => ({ async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: t } }; yield { type: 'message_stop' }; } , finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }], usage: {} }) });
deps.claude = { messages: { stream: p => { lastSystem = JSON.stringify(p.system); return fake('こんにちは。'); }, create: async () => ({ content: [{ type: 'text', text: '{}' }], usage: {} }) } };
deps.tts = { synthesizeSpeech: async () => [{ audioContent: Buffer.from('x') }] };
deps.stt = { streamingRecognize: () => { const e = new EventEmitter(); e.write = () => {}; e.end = () => {}; return e; } };
deps.db = false;
function client(port, hello) { return new Promise((resolve, reject) => {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/talk'), msgs = [], waiters = [];
  ws.on('message', d => { const m = JSON.parse(d.toString()); msgs.push(m); waiters.slice().forEach(w => w(m)); });
  ws.on('open', () => { ws.send(JSON.stringify(hello)); resolve({ ws, msgs, until: (pred, ms = 4000) => new Promise((ok, ng) => { const hit = msgs.find(pred); if (hit) return ok(hit); const t = setTimeout(() => ng(new Error('timeout')), ms); const w = m => { if (pred(m)) { clearTimeout(t); waiters.splice(waiters.indexOf(w), 1); ok(m); } }; waiters.push(w); }) }); });
  ws.on('error', reject); }); }
(async () => {
  const server = createServer().listen(0), port = server.address().port;
  const o = await client(port, { type: 'hello', idToken: 'own', app: 'hatabo' });
  await o.until(m => m.type === 'ready');
  o.ws.send(JSON.stringify({ type: 'clone_new', name: '受付くん', role: '受付', label: 'お店のお客さん', price: false, reserve: true, days: 30, note: '定休日は水曜' }));
  const c1 = await o.until(m => m.type === 'clones' && m.items && m.items.length === 1);
  const cl = c1.items[0]; assert.ok(/\?ref=c[a-z0-9]{6}/.test(cl.url) && cl.role === '受付' && cl.open, '分身ができてURLが出る');
  const v = await client(port, { type: 'hello', idToken: 'vis', app: 'hatabo', ref: cl.code });
  await v.until(m => m.type === 'ready');
  v.ws.send(JSON.stringify({ type: 'text', text: 'こんにちは' }));
  await v.until(m => m.type === 'reply_end' || m.type === 'text_end' || m.type === 'end', 6000).catch(() => {});
  await new Promise(r => setTimeout(r, 300));
  assert.ok(/ヒロさんの愛棒です（役割つき）/.test(lastSystem) && /受付/.test(lastSystem) && /定休日は水曜/.test(lastSystem) && /料金・値段の話はしない/.test(lastSystem), '分身の窓口は役割とメモで話す');
  v.ws.close();
  o.ws.send(JSON.stringify({ type: 'clone_set', code: cl.code, active: false }));
  await o.until(m => m.type === 'clones' && m.items && m.items[0] && m.items[0].active === false);
  const v2 = await client(port, { type: 'hello', idToken: 'vis', app: 'hatabo', ref: cl.code });
  const er = await v2.until(m => m.type === 'error'); assert.strictEqual(er.code, 'closed', '止めた分身はお休み');
  o.ws.send(JSON.stringify({ type: 'admin' }));
  const ad = await o.until(m => m.type === 'admin' && m.rows);
  assert.ok(ad.rows.some(r => r.code === cl.code && r.kind === 'clone') && ad.sum.clones === 1, '管理画面に分身が出る');
  o.ws.send(JSON.stringify({ type: 'admin_set', code: cl.code, roleNote: 'テスト', aisaiHelp: true }));
  const ad2 = await o.until(m => m.type === 'admin' && m.msg);
  assert.ok(ad2.audit.length === 1 && ad2.rows.find(r => r.code === cl.code).aisaiHelp === 1, '変更は記録に残る');
  const vv = await client(port, { type: 'hello', idToken: 'vis', app: 'hatabo' }); await vv.until(m => m.type === 'ready');
  vv.ws.send(JSON.stringify({ type: 'admin' })); const dn = await vv.until(m => m.type === 'admin'); assert.ok(dn.denied, '事務局以外は見られない');
  console.log('OK：役割つきの愛棒（作る・役割とメモで話す・止める）・事務局の管理画面（一覧・変更の記録・事務局だけ）');
  server.close(); process.exit(0);
})().catch(e => { console.error('NG', e); process.exit(1); });
