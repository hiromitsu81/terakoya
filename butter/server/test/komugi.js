// コムギ：マー君本人は制限なしの相棒、マー君の紹介の人は橋渡し役（制限つき）。紹介者「mac」がしるされる
'use strict';
const http = require('http');
const assert = require('assert');
const WebSocket = require('ws');
const sysText = s => Array.isArray(s) ? s.map(b => b.text).join('') : String(s || '');
const gasSrv = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const j = JSON.parse(b); res.setHeader('Content-Type', 'application/json');
    if (j.action === 'brain') return res.end(JSON.stringify({ ok: true, guest: true, owner: 'g:' + (j.idToken === 'mac' ? 'Umac' : 'U' + j.idToken), me: j.idToken === 'mac' ? 'マー君' : 'アヤ', role: '汎用', slots: [] }));
    res.end(JSON.stringify({ ok: true }));
  });
}).listen(0);
process.env.GAS_URL = 'http://127.0.0.1:' + gasSrv.address().port;
process.env.MAC_OWNERS = 'Umac';
process.env.BRIDGE_DAILY = '2';
process.env.CLAUDE_FAMILY = '0';
const { createServer, deps } = require('../server.js');
let lastSys = '';
deps.claude = { messages: {
  stream: p => { lastSys = sysText(p.system); return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: '[えがお]は、はいっ。' } }; }, finalMessage: async () => ({ usage: {}, stop_reason: 'end_turn' }), abort() {} }; },
  create: async () => ({ content: [{ type: 'text', text: '{}' }] }) } };
deps.tts = { synthesizeSpeech: async ({ input }) => [{ audioContent: Buffer.from('mp3:' + input.text) }] };
deps.stt = { streamingRecognize: () => ({ write() {}, end() {}, on() {} }) };
deps.db = false;
function client(port, hello) {
  return new Promise(resolve => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/talk'), msgs = [];
    ws.on('message', d => msgs.push(JSON.parse(d.toString())));
    ws.on('open', () => { ws.send(JSON.stringify(hello)); resolve({ ws, msgs, until: (f, ms = 3000) => new Promise((ok, ng) => { const t0 = Date.now(); const iv = setInterval(() => { const h = msgs.find(f); if (h) { clearInterval(iv); ok(h); } else if (Date.now() - t0 > ms) { clearInterval(iv); ng(new Error('timeout')); } }, 10); }) }); });
  });
}
(async () => {
  const srv = createServer().listen(0); const port = srv.address().port;
  // 紹介の人：コムギ・橋渡し・紹介者mac・1日2回まで
  const a = await client(port, { type: 'hello', idToken: 'aya', app: 'komugi', ref: 'mac' });
  const ra = await a.until(m => m.type === 'ready');
  assert.strictEqual(ra.avatar, 'komugi');
  for (let i = 0; i < 3; i++) { a.ws.send(JSON.stringify({ type: 'text', text: '相談があります' + i })); await new Promise(r => setTimeout(r, 300)); }
  assert(/橋渡し/.test(lastSys), '紹介の人には橋渡し役の決まり');
  assert(a.msgs.some(m => m.type === 'limit'), '紹介の人は1日の回数がある');
  // マー君本人：制限なし・橋渡しの決まりなし
  const m = await client(port, { type: 'hello', idToken: 'mac', app: 'komugi' });
  const rm = await m.until(x => x.type === 'ready');
  assert.strictEqual(rm.avatar, 'komugi');
  for (let i = 0; i < 4; i++) { m.ws.send(JSON.stringify({ type: 'text', text: '調べて' + i })); await new Promise(r => setTimeout(r, 300)); }
  assert(!m.msgs.some(x => x.type === 'limit'), 'マー君は制限なし');
  assert(/マー君本人/.test(lastSys) && !/橋渡し（いちばん大事）/.test(lastSys), 'マー君には相棒の決まり');
  // マー君がコムギ通信を入れる → 紹介の人のコムギが案内できる
  m.ws.send(JSON.stringify({ type: 'text', text: 'コムギ通信に入れて：今日の速報は円安。たとえるなら、海外旅行のお小遣いが目減りする話。' }));
  await m.until(x => x.type === 'note_saved' && x.kind === 'news');
  const b = await client(port, { type: 'hello', idToken: 'bob', app: 'komugi', ref: 'mac' });
  await b.until(x => x.type === 'ready');
  b.ws.send(JSON.stringify({ type: 'text', text: '今日の速報は？' })); await new Promise(r => setTimeout(r, 300));
  assert(/円安/.test(lastSys) && /マー君より/.test(lastSys), '紹介の人のコムギが、マー君の入れたコムギ通信を持っている');
  b.ws.close();
  a.ws.close(); m.ws.close(); srv.close(); gasSrv.close();
  console.log('OK：コムギ（マー君は制限なし・紹介の人は橋渡しで制限つき・マー君の入れたコムギ通信を紹介の人に案内）');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
