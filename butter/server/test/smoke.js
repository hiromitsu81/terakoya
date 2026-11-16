// 外のサービスをにせものにして、会話・写真・ご縁つなぎが一通り動くか確かめる
'use strict';
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
      const ok = j.pass === 'ok' || j.idToken === 'tok-' + 'b';
      return res.end(JSON.stringify(ok ? { ok: true, system: 'あなたはバターちゃんジュニア。', owner: j.pass ? 'fam' : 'U-b', me: j.pass ? 'パパ' : 'Bさん' } : { ok: false, error: 'auth' }));
    }
    res.end(JSON.stringify({ ok: true }));
  });
}).listen(0);

process.env.GAS_URL = 'http://127.0.0.1:' + gasSrv.address().port;
const srvMod = require('../server.js');
const { createServer, deps, splitter, takeEmotion } = srvMod;

// にせものの Claude：文字を少しずつ流す
const fakeStream = text => ({ async *[Symbol.asyncIterator]() { for (const ch of text.match(/.{1,3}/gs)) { await new Promise(r => setTimeout(r, 2)); yield { type: 'content_block_delta', delta: { type: 'text_delta', text: ch } }; } } });
let lastMessages = null;
deps.claude = {
  messages: {
    stream: (p) => { lastMessages = p.messages; return fakeStream('[わくわく]やっほー！今日はなにして遊ぶ？クイズもできるよ。'); },
    create: async () => ({ content: [{ type: 'text', text: '{"lines":[{"who":"チーちゃん","text":"こんにちは"},{"who":"ジャム猫","text":"千客万来なのだ"}],"match":"お祭りと宿で相性ばっちり。","next":"一度お茶してみてね。"}' }] }),
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
  // 部品
  const out = []; const sp = splitter(s => out.push(s)); sp.push('うん。今日はいい天気だね！公園に行こう'); sp.end();
  assert.deepStrictEqual(out, ['うん。今日はいい天気だね！', '公園に行こう']);
  assert.strictEqual(takeEmotion('[びっくり]えっ').emotion, 'surprise');

  const server = createServer().listen(0); const port = server.address().port;

  // 合言葉がちがうと切られる
  const bad = await client(port, { type: 'hello', pass: 'ng' });
  await bad.until(m => m.type === 'error' && m.code === 'auth');

  // 家族モードで会話
  const a = await client(port, { type: 'hello', pass: 'ok', mode: 'family' });
  await a.until(m => m.type === 'ready');
  a.ws.send(JSON.stringify({ type: 'text', text: 'こんにちは' }));
  const end = await a.until(m => m.type === 'reply_end');
  assert.strictEqual(end.emotion, 'excited');
  const audios = a.msgs.filter(m => m.type === 'audio');
  assert.ok(audios.length >= 2, '一文ずつ届く');
  assert.ok(!audios.some(x => /\[/.test(x.text)), '気持ちのしるしは読まない');
  assert.deepStrictEqual(audios.map(x => x.seq), audios.map((_, i) => i), '順番どおり');
  await new Promise(r => setTimeout(r, 50));
  assert.ok(gasCalls.some(c => c.action === 'log' && c.said === 'こんにちは'), '家族モードはおうち日記へ');

  // 写真
  a.ws.send(JSON.stringify({ type: 'text', text: 'バターちゃん、写真撮って' }));
  await a.until(m => m.type === 'camera' && m.kind === 'photo');
  a.ws.send(JSON.stringify({ type: 'photo', data: 'data:image/jpeg;base64,AAAA' }));
  await a.until(m => m.type === 'reply_end' && m.gen > end.gen);
  assert.ok(lastMessages[lastMessages.length - 1].content.some(c => c.type === 'image'), '写真がClaudeへ');

  // 交流会モードは記録しない
  await new Promise(r => setTimeout(r, 80));
  const before = gasCalls.filter(c => c.action === 'log').length;
  const b = await client(port, { type: 'hello', idToken: 'tok-b', mode: 'business' });
  await b.until(m => m.type === 'ready');
  b.ws.send(JSON.stringify({ type: 'text', text: 'はじめまして' }));
  await b.until(m => m.type === 'reply_end');
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(gasCalls.filter(c => c.action === 'log').length, before, '交流会は記録しない');

  // ご縁つなぎ
  a.ws.send(JSON.stringify({ type: 'profile', profile: { character: 'ジャム猫', skills: '仕組みづくり', seeking: 'お祭り仲間', shareable: '溝の口でフェス' } }));
  const pa = await a.until(m => m.type === 'profile');
  b.ws.send(JSON.stringify({ type: 'profile', profile: { character: 'チーちゃん', skills: '宿の運営', seeking: 'DX', shareable: 'ニセコの宿' } }));
  await b.until(m => m.type === 'profile');
  b.ws.send(JSON.stringify({ type: 'goen', code: pa.profile.code.toLowerCase() }));
  const g = await b.until(m => m.type === 'goen_result');
  assert.ok(g.lines.length === 2 && g.match);
  await a.until(m => m.type === 'reply_end' && /話してきたよ/.test(m.text) === false || true);
  await new Promise(r => setTimeout(r, 50));

  // 話の途中で割りこみ
  const n0 = a.msgs.filter(m => m.type === 'reply_start').length;
  a.ws.send(JSON.stringify({ type: 'text', text: 'お話して' }));
  await a.until(() => a.msgs.filter(m => m.type === 'reply_start').length > n0);
  a.ws.send(JSON.stringify({ type: 'barge' }));
  await a.until(m => m.type === 'stopped');

  console.log('OK：会話・気持ち・一文ずつの声・写真・記録の分け方・ご縁つなぎ・割りこみ');
  process.exit(0);
})().catch(e => { console.error('NG', e); process.exit(1); });
