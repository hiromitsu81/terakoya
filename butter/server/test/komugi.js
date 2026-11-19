// コムギ：マー君本人は制限なしの相棒、マー君の紹介の人は橋渡し役（制限つき）。紹介者「mac」がしるされる
'use strict';
const http = require('http');
const assert = require('assert');
const WebSocket = require('ws');
const sysText = s => Array.isArray(s) ? s.map(b => b.text).join('') : String(s || '');
const gasLeads = [];
const gasSrv = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const j = JSON.parse(b); res.setHeader('Content-Type', 'application/json'); if (j.action === 'lead') gasLeads.push(j.lead || {});
    if (j.action === 'brain') return res.end(JSON.stringify({ ok: true, guest: true, owner: 'g:' + (j.idToken === 'mac' ? 'Umac' : 'U' + j.idToken), me: j.idToken === 'mac' ? 'マー君' : j.idToken === 'hiro' ? 'ヒロ' : 'アヤ', role: '汎用', slots: [] }));
    res.end(JSON.stringify({ ok: true }));
  });
}).listen(0);
process.env.GAS_URL = 'http://127.0.0.1:' + gasSrv.address().port;
process.env.MAC_OWNERS = 'Umac'; process.env.KOMUGI_OWNERS = 'Uhiro';
process.env.OFFICE_OWNERS = 'Uoffice';
process.env.CRON_KEY = 'k';
process.env.BRIDGE_DAILY = '2';
process.env.CLAUDE_FAMILY = '0';
const { createServer, deps } = require('../server.js');
let lastSys = '';
deps.claude = { messages: {
  stream: p => { lastSys = sysText(p.system); return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: '[えがお]は、はいっ。' } }; }, finalMessage: async () => ({ usage: {}, stop_reason: 'end_turn' }), abort() {} }; },
  create: async p => /事務局の受付係/.test(p.system || '') ? ({ content: [{ type: 'text', text: '{"is":true,"kind":"不具合","title":"返事が出ない","detail":"質問しても返事が出ない"}' }] }) : ({ content: [{ type: 'text', text: '{}' }] }) } };
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
  require('fs').writeFileSync('/tmp/sys_bridge.txt', lastSys); assert(/HUB役/.test(lastSys), '紹介の人にはHUB役の決まり');
  assert(a.msgs.some(m => m.type === 'limit'), '紹介の人は1日の回数がある');
  // マー君本人：制限なし・橋渡しの決まりなし
  const m = await client(port, { type: 'hello', idToken: 'mac', app: 'komugi' });
  const rm = await m.until(x => x.type === 'ready');
  assert.strictEqual(rm.avatar, 'komugi');
  for (let i = 0; i < 4; i++) { m.ws.send(JSON.stringify({ type: 'text', text: '調べて' + i })); await new Promise(r => setTimeout(r, 300)); }
  require('fs').writeFileSync('/tmp/sys_mac.txt', lastSys); assert(!m.msgs.some(x => x.type === 'limit'), 'マー君は制限なし');
  assert(/馬越 雅哉さん本人/.test(lastSys) && !/HUB役（いちばん大事）/.test(lastSys), 'マー君には相棒の決まり');
  // ヒロさん（KOMUGI_OWNERS）：マー君と同じ使い方。制限なし・橋渡しなし・相手はヒロさん
  const h = await client(port, { type: 'hello', idToken: 'hiro', app: 'komugi' });
  await h.until(x => x.type === 'ready');
  for (let i = 0; i < 4; i++) { h.ws.send(JSON.stringify({ type: 'text', text: '相談' + i })); await new Promise(r => setTimeout(r, 300)); }
  assert(!h.msgs.some(x => x.type === 'limit'), 'ヒロさんも制限なし');
  assert(/ヒロさん本人/.test(lastSys) && !/馬越 雅哉さん本人/.test(lastSys) && !/HUB役（いちばん大事）/.test(lastSys), 'ヒロさんにも相棒の決まり（相手はヒロさん）');
  h.ws.close();
  // 不具合・要望は、ハタボ事務局へ
  m.ws.send(JSON.stringify({ type: 'text', text: '返事が出ない不具合があるので直してほしい' }));
  await new Promise(r => setTimeout(r, 500));
  assert(gasLeads.some(l => /事務局：不具合/.test(l.kind || '')), '不具合はハタボ事務局へ届く');
  // マー君が教えたことは、紹介先のコムギにも引きつぐ
  m.ws.send(JSON.stringify({ type: 'text', text: '紹介の人には、まず業種を聞くことを覚えて' }));
  await new Promise(r => setTimeout(r, 400));
  // マー君がコムギ通信を入れる → 紹介の人のコムギが案内できる
  m.ws.send(JSON.stringify({ type: 'text', text: 'コムギ通信に入れて：今日の速報は円安。たとえるなら、海外旅行のお小遣いが目減りする話。' }));
  await m.until(x => x.type === 'note_saved' && x.kind === 'news');
  const b = await client(port, { type: 'hello', idToken: 'bob', app: 'komugi', ref: 'mac' });
  await b.until(x => x.type === 'ready');
  b.ws.send(JSON.stringify({ type: 'text', text: '今日の速報は？' })); await new Promise(r => setTimeout(r, 300));
  assert(/円安/.test(lastSys) && /馬越さんより/.test(lastSys), '紹介の人のコムギが、マー君の入れたコムギ通信を持っている');
  assert(/まず業種を聞く/.test(lastSys), '親が教えたことに、紹介先のコムギも従う');
  assert(!/AIの便利屋のプロ/.test(lastSys) && !/ふだんのハタボ/.test(lastSys), 'コムギにハタボ・ジュニアの案内文が入らない');
  b.ws.close();
  // 1日1回のまとめ：事務局への声は、まとめの箱に入り、/cron/digest で送られて空になる
  const cron = await new Promise(r => http.get('http://127.0.0.1:' + port + '/cron/digest?key=k', res => { let b = ''; res.on('data', c => b += c); res.on('end', () => r(b)); }));
  assert(/sent [1-9]/.test(cron), 'まとめを送る: ' + cron);
  const bad = await new Promise(r => http.get('http://127.0.0.1:' + port + '/cron/digest?key=x', res => r(res.statusCode)));
  assert.strictEqual(bad, 403, '合図のキーがちがえば送らない');
  a.ws.close(); m.ws.close(); srv.close(); gasSrv.close();
  console.log('OK：コムギ（マー君とヒロさんは制限なし・紹介の人は橋渡しで制限つき・マー君の入れたコムギ通信を紹介の人に案内）');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
