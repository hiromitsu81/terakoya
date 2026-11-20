// 管理画面：会話ごとの記録・見える範囲・既読・返事・相談の回数・スタッフ・愛棒の設定・お客さまへの一文
'use strict';
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
const { createServer, deps, hoursOpen, webSign } = require('../server.js');
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
(async () => {
  assert.ok(hoursOpen(null) && !hoursOpen({ open: '00:00', close: '00:01', closed: [0, 1, 2, 3, 4, 5, 6] }), '営業時間の判定');
  const server = createServer().listen(0), port = server.address().port;
  const o = await client(port, { type: 'hello', idToken: 'own', app: 'hatabo' }); const oR = await o.until(m => m.type === 'ready');
  o.send({ type: 'clone_new', name: '受付', role: '受付', reserve: true, listed: true });
  const cl = (await o.until(m => m.type === 'clones' && m.items && m.items.length)).items[0];
  const v = await client(port, { type: 'hello', idToken: 'vis', app: 'hatabo', ref: cl.code }); const vR = await v.until(m => m.type === 'ready');
  assert.ok(vR.shopView, 'お客さまに「お店の方も見られます」の合図');
  replyText = 'かしこまりました。お店に伝えておきますね。';
  await talk(v, '12月5日に4人で予約したいです');
  v.ws.close();
  const v2 = await client(port, { type: 'hello', idToken: 'vis', app: 'hatabo' }); await v2.until(m => m.type === 'ready');
  replyText = 'こんにちは。'; await talk(v2, 'ひとりごとです');
  // オーナー：自分の愛棒の会話は見える。お客さまの自分のハタボの会話は見えない
  o.send({ type: 'console' }); const c1 = await o.until(m => m.type === 'console' && m.threads);
  const th = c1.threads.find(t => t.aibo === cl.code);
  assert.ok(th && th.unread === 1 && th.entry === 'url' && th.body && c1.sums.unread === 1 && c1.threads.length === 1, 'オーナーは自分の愛棒の会話だけ・伝言は未読1');
  assert.ok(!JSON.stringify(c1).includes('Ubbbb'), 'LINEのIDは出さない');
  o.send({ type: 'thr_goen', id: th.id }); const tg = await o.until(m => m.type === 'thr_goen');
  assert.ok(tg.id === th.id && Array.isArray(tg.to), 'トーク一覧：その人のご縁');
  assert.ok('pic' in th && th.hasRef, 'アイコンの欄と、ご縁が見られる印');
  o.send({ type: 'thr_open', id: th.id }); const op = await o.until(m => m.type === 'thread');
  assert.ok(op.t.turns.length === 2 && op.t.canReply && op.panel.editAibo, '開くと中身・返事できる・愛棒を直せる');
  o.send({ type: 'console' }); assert.strictEqual((await o.until(m => m.type === 'console' && m.threads)).sums.unread, 0, '開いたら既読');
  o.send({ type: 'thr_draft', id: th.id }); assert.ok(/4名/.test((await o.until(m => m.type === 'thr_draft')).draft), '返事の下書き');
  o.send({ type: 'thr_send', id: th.id, text: 'お待ちしております' }); await o.until(m => m.type === 'thr_sent');
  o.send({ type: 'thr_open', id: th.id }); assert.ok((await o.until(m => m.type === 'thread' && m.t.turns.length === 3)).t.turns[2].r === 'shop', '送った返事も会話に残る');
  o.send({ type: 'consult', id: th.id }); const k1 = await o.until(m => m.type === 'consult'); assert.ok(k1.ok && /予約/.test(k1.prompt), '相談役に相談（1回目）');
  o.send({ type: 'consult', id: th.id }); const k2 = await o.until(m => m.type === 'consult' && m !== k1); assert.ok(!k2.ok, 'いちばん安いプランは1日1回');
  o.send({ type: 'aibo_set', code: cl.code, learnedAdd: '水曜は定休', keepDays: 365, hours: { open: '10:00', close: '21:00', closed: [3] } });
  await o.until(m => m.type === 'console' && m.msg === '愛棒の設定を変えました');
  o.send({ type: 'thr_open', id: th.id }); const op2 = await o.until(m => m.type === 'thread' && m.panel.learned.length === 1);
  assert.ok(op2.panel.keepDays === 90 && op2.panel.hours.open === '10:00', '残す期間はプランの上限まで（Xは90日）・営業時間');
  // スタッフ：見るだけの人は返事できない
  o.send({ type: 'staff_add', code: vR.myRef, role: 'view' }); await o.until(m => m.type === 'console' && /登録/.test(m.msg || ''));
  v2.send({ type: 'console' }); const vc = await v2.until(m => m.type === 'console' && m.threads);
  const vt = vc.threads.find(t => t.aibo === cl.code); assert.ok(vt && vc.threads.find(t => t.self), 'スタッフは任された店の会話と、自分の会話が見える');
  v2.send({ type: 'thr_open', id: vt.id }); assert.ok(!(await v2.until(m => m.type === 'thread')).t.canReply, '見るだけの人は返事できない');
  // 事務局：ぜんぶ見える。オーナーが自分のハタボと話した会話は中身なし（許したら見える）
  const f = await client(port, { type: 'hello', idToken: 'off', app: 'hatabo' }); await f.until(m => m.type === 'ready');
  f.send({ type: 'console' }); const fc = await f.until(m => m.type === 'console' && m.threads);
  const selfT = fc.threads.find(t => t.self); assert.ok(fc.office && fc.threads.length === 2 && selfT && !selfT.body && !/ひとりごと/.test(JSON.stringify(fc)), '事務局はぜんぶ・自分のハタボの会話は件数と日時だけ');
  f.send({ type: 'console', as: 'self' }); const fs1 = await f.until(m => m.type === 'console' && m.threads && m.as === 'self');
  assert.ok(!fs1.office && fs1.canOffice && fs1.threads.length === 0, '事務局の人も「自分」にすると、自分の分だけ');
  f.send({ type: 'console', as: 'office' }); const fs2 = await f.until(m => m.type === 'console' && m.threads && m.as === 'office');
  assert.ok(fs2.office && fs2.threads.length === 2, '「事務局」にもどすと、ぜんぶ');
  v2.send({ type: 'con_set', shareSelf: true }); await v2.until(m => m.type === 'console' && m.msg);
  f.send({ type: 'console' }); assert.ok((await f.until(m => m.type === 'console' && m.threads && m !== fc)).threads.find(t => t.self).body, '本人が許したら事務局にも中身');
  f.send({ type: 'con_url_new', name: 'セミナー受付', role: 'サービス相談', days: 30 }); const fu = await f.until(m => m.type === 'console' && m.msg === '紹介URLを作りました');
  assert.ok(fu.aibos.some(a => a.kind === 'url' && a.name === 'セミナー受付'), '事務局は紹介URLを作れる');
  // Googleでログインした事務局（LINEなし）も見られる
  const g = await client(port, { type: 'hello', webToken: webSign({ owner: '', office: true, email: 's@x', exp: Date.now() + 60000 }), app: 'hatabo' }); await g.until(m => m.type === 'ready');
  g.send({ type: 'console' }); assert.ok((await g.until(m => m.type === 'console')).threads.length === 2, 'Googleの事務局も会話の一覧');
  console.log('OK：管理画面（会話ごとの記録・未読・既読・下書きと返事・相談の回数・残す期間・営業時間・スタッフの権限・事務局の見える範囲・お客さまへの一文）');
  server.close(); process.exit(0);
})().catch(e => { console.error('NG', e); process.exit(1); });
