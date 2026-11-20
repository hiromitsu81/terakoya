// ハタボAPI（MCPサーバー）と、ウェブのログイン（Googleの印）
'use strict';
const http = require('http'), assert = require('assert'), WebSocket = require('ws'), { EventEmitter } = require('events');
const gasSrv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
  const j = JSON.parse(b); res.setHeader('Content-Type', 'application/json');
  if (j.action === 'brain') {
    if (j.idToken === 'own') return res.end(JSON.stringify({ ok: true, guest: true, owner: 'g:Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', me: 'ヒロ', role: '汎用', slots: [] }));
    if (j.idToken === 'vis') return res.end(JSON.stringify({ ok: true, guest: true, owner: 'g:Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', me: 'ともだち', role: '汎用', slots: [] }));
    return res.end(JSON.stringify({ ok: false, error: 'auth' }));
  }
  res.end(JSON.stringify({ ok: true }));
}); }).listen(0);
process.env.GAS_URL = 'http://127.0.0.1:' + gasSrv.address().port;
process.env.OFFICE_OWNERS = 'Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.WEB_SECRET = 'test-secret';
process.env.API_PRICE = '{"free":2}';
const { createServer, deps, webSign } = require('../server.js');
const fake = t => ({ async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: t } }; yield { type: 'message_stop' }; }, finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }], usage: {} }) });
deps.claude = { messages: { stream: () => fake('こんにちは。'), create: async () => ({ content: [{ type: 'text', text: '{}' }], usage: {} }) } };
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
  let rid = 1;
  const rpc = async (path, method, params, hdr) => { const r = await fetch('http://127.0.0.1:' + port + path, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, hdr || {}), body: JSON.stringify({ jsonrpc: '2.0', id: rid++, method, params }) }); const t = await r.text(); return { status: r.status, j: t ? JSON.parse(t) : null, t }; };
  const o = await client(port, { type: 'hello', idToken: 'own', app: 'hatabo' }); await o.until(m => m.type === 'ready');
  o.ws.send(JSON.stringify({ type: 'clone_new', name: 'そば処の受付', role: '受付', label: 'お店のお客さん', area: '高津区', listed: true, reserve: true, days: 30 }));
  const c1 = await o.until(m => m.type === 'clones' && m.items && m.items.length === 1); const cl = c1.items[0];
  assert.ok(cl.listed && cl.area === '高津区', '愛棒に「検索に出す」と地域');
  o.ws.send(JSON.stringify({ type: 'api_new', name: 'ChatGPT' }));
  const k1 = await o.until(m => m.type === 'api' && m.newKey); const key = k1.newKey;
  assert.ok(/^hb_[0-9a-f]{48}$/.test(key) && k1.newUrl.endsWith('/mcp/' + key) && k1.keys.length === 1, 'APIキーとURLができる');
  const P = '/mcp/' + key;
  const ini = await rpc(P, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.ok(ini.j.result.serverInfo.name === 'hatabo' && ini.j.result.capabilities.tools, 'initialize');
  const nt = await fetch('http://127.0.0.1:' + port + P, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.strictEqual(nt.status, 202, 'お知らせは202');
  const tl = await rpc(P, 'tools/list'); assert.ok(tl.j.result.tools.some(t => t.name === 'search_aibo') && tl.j.result.tools.length === 6, 'tools/list');
  const sr = await rpc('/mcp', 'tools/call', { name: 'search_aibo', arguments: { query: 'そば', area: '高津区' } }, { Authorization: 'Bearer ' + key });
  const found = sr.j.result.structuredContent; assert.ok(found.found === 1 && found.aibo[0].id === cl.code && found.aibo[0].can_reserve, 'さがす（Bearerでも）');
  const all = JSON.stringify([ini.j, tl.j, sr.j]); assert.ok(!/U[0-9a-f]{32}/.test(all) && !/"owner":"g:/.test(all), 'LINEのIDは外に出さない');
  const sm = await rpc(P, 'tools/call', { name: 'send_message', arguments: { aibo: cl.code, text: '12月の営業日を教えてください', from_name: 'たろう' } });
  assert.ok(sm.j.result.structuredContent.ok, '伝言');
  const rv = await rpc(P, 'tools/call', { name: 'request_reservation', arguments: { aibo: cl.code, when: '12月5日 19時', people: 4, name: 'たろう' } });
  assert.ok(rv.j.result.structuredContent.ok && rv.j.result.structuredContent.yen === 5, '予約の希望（無料の2回をこえたので5円）');
  const ng = await rpc(P, 'tools/call', { name: 'send_message', arguments: { aibo: 'cxxxxxxx', text: 'x', from_name: 'x' } }); assert.ok(ng.j.result.isError, 'ない愛棒はエラー');
  const up = await rpc(P, 'tools/call', { name: 'update_my_aibo', arguments: { aibo: cl.code, note: '水曜定休', about: '近所のかた' } }); assert.ok(up.j.result.structuredContent.aibo[0].note === '水曜定休', 'APIで設定を変える');
  o.ws.send(JSON.stringify({ type: 'clones' })); await o.until(m => m.type === 'clones' && m.items[0].note === '水曜定休'); 
  o.ws.send(JSON.stringify({ type: 'inbox' })); await new Promise(r => setTimeout(r, 300));
  o.ws.send(JSON.stringify({ type: 'api' })); const a2 = await o.until(m => m.type === 'api' && m.reserves && m.reserves.length === 1 && !m.newKey);
  assert.ok(a2.usage.billable === 3 && a2.usage.search === 1 && a2.usage.message === 1 && a2.usage.reserve === 1 && a2.usage.yen === 5 && !a2.keys[0].tail.includes(key.slice(0, 10)), '使った分（キーは2度と出ない）');
  o.ws.send(JSON.stringify({ type: 'api_resv', id: a2.reserves[0].id, status: 'done' })); const a3 = await o.until(m => m.type === 'api' && m.msg === '成立にしました。');
  assert.ok(a3.usage.done === 1 && a3.usage.yen === 35, '予約の成立は30円');
  o.ws.send(JSON.stringify({ type: 'admin' })); const ad = await o.until(m => m.type === 'admin' && m.rows);
  assert.ok(ad.sum.api === 3 && ad.sum.apiYen === 35, '管理画面にAPIの使った分');
  o.ws.send(JSON.stringify({ type: 'api_stop', id: a2.keys[0].id })); await o.until(m => m.type === 'api' && m.msg === 'APIキーを止めました。');
  const st = await rpc(P, 'tools/list'); assert.strictEqual(st.status, 401, '止めたキーは使えない');
  const bad = await rpc('/mcp/hb_nope', 'tools/list'); assert.strictEqual(bad.status, 401, 'ちがうキー');
  // ウェブのログイン（Googleの印）
  const w1 = await client(port, { type: 'hello', webToken: webSign({ owner: 'g:Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', office: true, email: 'h@x', exp: Date.now() + 60000 }), app: 'hatabo' });
  const r1 = await w1.until(m => m.type === 'ready'); assert.ok(r1.office && r1.web && r1.myRef === o.msgs.find(m => m.type === 'ready').myRef, 'Googleの印で、同じMyハタボ・事務局');
  w1.ws.send(JSON.stringify({ type: 'clones' })); await w1.until(m => m.type === 'clones' && m.items.length === 1);
  const w2 = await client(port, { type: 'hello', webToken: webSign({ owner: '', office: true, email: 'staff@x', exp: Date.now() + 60000 }), app: 'hatabo' });
  await w2.until(m => m.type === 'ready'); w2.ws.send(JSON.stringify({ type: 'admin' })); const ad2 = await w2.until(m => m.type === 'admin'); assert.ok(!ad2.denied && ad2.rows.length, '事務局のメールなら管理画面');
  const w3 = await client(port, { type: 'hello', webToken: webSign({ owner: 'g:x', office: false, exp: Date.now() - 1 }), app: 'hatabo' });
  const e3 = await w3.until(m => m.type === 'error'); assert.strictEqual(e3.code, 'auth', '期限切れの印は入れない');
  const w4 = await client(port, { type: 'hello', webToken: 'abc.def', app: 'hatabo' }); assert.strictEqual((await w4.until(m => m.type === 'error')).code, 'auth', 'にせの印は入れない');
  console.log('OK：ハタボAPI（MCP：さがす・伝言・予約の希望・設定・使った分・キーの停止）・ウェブのログイン（Googleの印）');
  server.close(); process.exit(0);
})().catch(e => { console.error('NG', e); process.exit(1); });
