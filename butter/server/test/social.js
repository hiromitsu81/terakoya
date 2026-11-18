// 外のサービスをにせものにして、会話・写真・ご縁つなぎが一通り動くか確かめる
'use strict';
const sysText = s => Array.isArray(s) ? s.map(b => b.text).join('') : String(s || '');
const http = require('http');
const assert = require('assert');
const WebSocket = require('ws');
const { EventEmitter } = require('events');

const gasCalls = [];
const gasSrv = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const j = JSON.parse(b); gasCalls.push(j);
    res.setHeader('Content-Type', 'application/json');
    if (j.action === 'brain') {
      if (j.pass === 'flaky') return res.end('<html>error</html>');
      if (j.idToken === 'guest-closed') return res.end(JSON.stringify({ ok: true, guest: true, closed: true }));
      if (j.idToken === 'guest-y') return res.end(JSON.stringify({ ok: true, guest: true, owner: 'g:y', me: 'ユウ', slots: [] }));
      if (j.idToken === 'guest-x') return res.end(JSON.stringify({ ok: true, guest: true, owner: 'g:x', me: 'マー君', role: 'サポート・コンサル相談', consult: j.ref === 'macpmo' ? '清掃シートのAirHost連携を来月までに' : '', slots: [{ label: '11/20(木) 19時ごろ', start: '2026-11-20T10:00:00Z', end: '2026-11-20T12:00:00Z' }] }));
      const ok = j.pass === 'ok' || j.idToken === 'tok-' + 'b';
      return res.end(JSON.stringify(ok ? { ok: true, system: 'あなたはバターちゃんジュニア。', owner: j.pass ? 'fam' : 'U-b', me: j.pass ? 'パパ' : 'Bさん' } : { ok: false, error: 'auth' }));
    }
    if (j.action === 'mail') return res.end(JSON.stringify(j.idToken === 'tok-b' ? { ok: true, mails: [{ from: 'たくちゃん', subject: '清掃シートの件', snippet: '明日見てください' }] } : { ok: false, error: 'owner' }));
    if (j.action === 'minutes') return res.end(JSON.stringify({ ok: true, url: 'https://drive.google.com/file/d/minutes' }));
    if (j.action === 'media') return res.end(JSON.stringify({ ok: true, url: 'https://drive.google.com/file/d/photo' }));
    res.end(JSON.stringify({ ok: true }));
  });
}).listen(0);

process.env.CLAUDE_FAMILY = '1';
process.env.GAS_URL = 'http://127.0.0.1:' + gasSrv.address().port;
const srvMod = require('../server.js');
const { createServer, deps, splitter, takeEmotion } = srvMod;

// にせものの Claude：文字を少しずつ流す
const fakeStream = text => ({ async *[Symbol.asyncIterator]() { for (const ch of text.match(/.{1,3}/gs)) { await new Promise(r => setTimeout(r, 2)); yield { type: 'content_block_delta', delta: { type: 'text_delta', text: ch } }; } } });
let lastMessages = null;
deps.claude = {
  messages: {
    stream: (p) => { lastMessages = p.messages; return fakeStream('[わくわく]やっほー！今日はなにして遊ぶ？クイズもできるよ。'); },
    create: async p => /窓口AIの記録係/.test(p.system || '') ? ({ content: [{ type: 'text', text: '{"worth":true,"kind":"仕事","title":"宿のDX","need":"予約の仕組み","when":"来月","budget":"","slot":"11/20(木) 19時ごろ","next":"連絡する","memo":"宿のDXの相談"}' }] }) : /記録係/.test(p.system || '') ? ({ content: [{ type: 'text', text: '===まとめ===\n- ピョン吉のトレーナーの話をした\n===日記===\n- パパがトレーナーを買った\n===学び===\n- パパは家族の人数を聞かれたらちゃんと答えてほしい' }] }) : ({ content: [{ type: 'text', text: '{"lines":[{"who":"チーちゃん","text":"こんにちは"},{"who":"ジャム猫","text":"千客万来なのだ"}],"match":"お祭りと宿で相性ばっちり。","next":"一度お茶してみてね。"}' }] }),
  },
};
deps.tts = { synthesizeSpeech: async ({ input }) => [{ audioContent: Buffer.from('mp3:' + input.text) }] };
deps.stt = { streamingRecognize: () => { const e = new EventEmitter(); e.write = () => {}; e.end = () => e.emit('end'); return e; } };
deps.db = false;

function client(port, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/talk');
    const msgs = []; const waiters = [];
    ws.on('message', d => { const m = JSON.parse(d.toString()); msgs.push(m); waiters.slice().forEach(w => w(m)); });
    ws.on('open', () => { ws.send(JSON.stringify(hello)); resolve({ ws, msgs, until: (pred, ms = 3000) => new Promise((ok, ng) => {
      const hit = msgs.find(pred); if (hit) return ok(hit);
      const t = setTimeout(() => ng(new Error('timeout')), ms);
      const w = m => { if (pred(m)) { clearTimeout(t); waiters.splice(waiters.indexOf(w), 1); ok(m); } }; waiters.push(w);
    }) }); });
    ws.on('error', reject);
  });
}


(async () => {
  const server = createServer().listen(0); const port = server.address().port;
  const y = await client(port, { type: 'hello', idToken: 'guest-y' }); await y.until(m => m.type === 'ready');
  y.ws.send(JSON.stringify({ type: 'funnel', act: 'contract', lineup: 'ris', grade: 'G', pay: 'm' }));
  await y.until(m => m.type === 'mypage' && m.funnel && m.funnel.stage === 'contract');
  y.ws.send(JSON.stringify({ type: 'social', gachaOn: true, showLine: true, lineId: 'yuu_line', showInsta: false, insta: 'yuu.insta' }));
  await y.until(m => m.type === 'friends' && m.me.lineId === 'yuu_line');
  const x = await client(port, { type: 'hello', idToken: 'guest-x' }); await x.until(m => m.type === 'ready');
  const R = Math.random; Math.random = () => 0.5;
  x.ws.send(JSON.stringify({ type: 'gacha' }));
  const g = await x.until(m => m.type === 'gacha' && m.card);
  Math.random = R;
  assert.strictEqual(g.card.kind, 'user', 'ガチャで契約している人が出る'); assert.ok(!g.card.lineId, 'ガチャではLINE IDを見せない');
  x.ws.send(JSON.stringify({ type: 'gacha' }));
  const g2 = await x.until(m => m.type === 'gacha' && m.need);
  assert.ok(g2.need, '2回目はポイントがいる');
  x.ws.send(JSON.stringify({ type: 'friend_req', code: g.card.code || g.card.id }));
  await x.until(m => m.type === 'friends' && m.out.length === 1);
  y.ws.send(JSON.stringify({ type: 'friends' }));
  const fy = await y.until(m => m.type === 'friends' && m.inbox.length === 1);
  y.ws.send(JSON.stringify({ type: 'friend_ok', code: fy.inbox[0].code }));
  await y.until(m => m.type === 'friends' && m.list.length === 1);
  x.ws.send(JSON.stringify({ type: 'friends' }));
  const fx = await x.until(m => m.type === 'friends' && m.list.length === 1);
  assert.strictEqual(fx.list[0].lineId, 'yuu_line', '友だちにはLINE IDが見える'); assert.strictEqual(fx.list[0].insta, '', 'インスタは見せない設定');
  x.ws.send(JSON.stringify({ type: 'inbox_send', to: fx.list[0].code, text: 'よろしく！' }));
  await x.until(m => m.type === 'inbox' && m.sent);
  y.ws.send(JSON.stringify({ type: 'inbox' }));
  await y.until(m => m.type === 'inbox' && m.items.some(i => /よろしく/.test(i.text)));
  // 協賛のAI棒と話す
  const v = await client(port, { type: 'hello', idToken: 'guest-x', visit: 'sp-boshu' });
  const rv = await v.until(m => m.type === 'ready');
  assert.ok(rv.visit && /協賛/.test(rv.visit.name), '協賛のAI棒');
  // 家族はいつもClaudeと同じ（スーパー上位・長さの決まりなし）
  let fp = null; const o = deps.claude.messages.stream; deps.claude.messages.stream = p => { fp = p; return o(p); };
  const fam = await client(port, { type: 'hello', pass: 'ok', mode: 'family' }); const rf = await fam.until(m => m.type === 'ready');
  assert.ok(rf.claude && rf.canPlan, '家族はClaudeモード');
  fam.ws.send(JSON.stringify({ type: 'text', text: 'こんにちは' })); await fam.until(m => m.type === 'reply_end');
  assert.ok(/opus/.test(fp.model) && /Claudeと同じように/.test(sysText(fp.system)), '家族はいちばん賢いモデルとClaudeと同じ答え方');
  deps.claude.messages.stream = o;
  // キャラ設定
  const fam2 = await client(port, { type: 'hello', pass: 'ok', mode: 'family' }); await fam2.until(m => m.type === 'ready');
  fam2.ws.send(JSON.stringify({ type: 'custom_set', c: { aiName: 'ピヨ', callMe: 'ヒロさん', tone: 'polite', len: 'short', about: '川崎でお祭り', rules: '結論から' } }));
  const cs = await fam2.until(m => m.type === 'custom' && m.saved);
  fam2.ws.send(JSON.stringify({ type: 'custom_set', c: { aiName: 'べつの名前' } }));
  const cs2 = await fam2.until(m => m.type === 'custom' && m.saved && m !== cs);
  assert.strictEqual(cs2.c.aiName, 'ピヨ', '名前の変更はオプション');
  let fp2 = null; const o3 = deps.claude.messages.stream; deps.claude.messages.stream = p => { fp2 = p; return o3(p); };
  fam2.ws.send(JSON.stringify({ type: 'text', text: 'やあ' })); const rs = await fam2.until(m => m.type === 'reply_start');
  await fam2.until(m => m.type === 'reply_end'); deps.claude.messages.stream = o3;
  assert.ok(/キャラ設定/.test(sysText(fp2.system)) && rs.as === 'ピヨ', 'キャラ設定が会話に入る');
  console.log('OK：ガチャ・友だち・LINE ID・伝言・協賛・キャラ設定'); process.exit(0);
})().catch(e => { console.error('NG', e); process.exit(1); });
