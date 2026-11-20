// チャット：新しいチャット・一覧・前のチャットの続き・声の試し聞き
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
  const server = createServer().listen(0), port = server.address().port;
  const o = await client(port, { type: 'hello', idToken: 'own', app: 'hatabo' }); await o.until(m => m.type === 'ready');
  await talk(o, 'お祭りの企画を相談したい');
  o.send({ type: 'chats' }); const a = await o.until(m => m.type === 'chats');
  assert.ok(a.list.length === 1 && /お祭り/.test(a.list[0].title) && a.cur === a.list[0].id, '一覧に今のチャット（はじめの言葉が題名）');
  o.send({ type: 'chat_new' }); const nt = await o.until(m => m.type === 'chat_turns', 20000);
  assert.ok(nt.turns.length === 0 && nt.id !== a.cur, '新しいチャットはまっさら');
  await talk(o, '清掃管理のシートの話');
  o.send({ type: 'chats' }); const b = await o.until(m => m.type === 'chats' && m.list.length === 2);
  assert.ok(/清掃/.test(b.list[0].title) && /お祭り/.test(b.list[1].title), '新しい順');
  o.send({ type: 'chat_open', id: a.cur }); const op = await o.until(m => m.type === 'chat_turns' && m.id === a.cur);
  assert.ok(op.turns.length === 2 && /お祭り/.test(op.turns[0].content), '前のチャットの続きが開く');
  o.send({ type: 'voice_try', voice: 'm-calm' }); await o.until(m => m.type === 'audio');
  o.send({ type: 'byok_set', key: 'abc' }); assert.ok((await o.until(m => m.type === 'byok')).error, 'Claudeのキーでないものはことわる');
  o.send({ type: 'byok_set', key: 'sk-ant-api03-' + 'x'.repeat(40) + 'WXYZ' }); const bs = await o.until(m => m.type === 'byok' && m.saved);
  assert.ok(bs.set && bs.tail === 'WXYZ' && !JSON.stringify(bs).includes('xxxx'), '自分のキーをしまう（画面には末尾だけ）');
  o.send({ type: 'byok_get' }); assert.ok((await o.until(m => m.type === 'byok' && !m.saved)).set, 'しまってある');
  o.send({ type: 'byok_del' }); assert.ok((await o.until(m => m.type === 'byok' && m.removed)).set === false, '消せる');
  o.ws.close(); server.close(); gasSrv.close();
  console.log('chats ok'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
