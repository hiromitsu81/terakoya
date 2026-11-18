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

process.env.CLAUDE_FAMILY = '0';   // 家族のClaudeモードは別に確かめる（ここでは速いモデルの切りかえを見る）
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

  // 三人モード：呼ばれないと答えない。呼ばれたら、まわりの会話もいっしょに渡す。自分はジュニア
  await new Promise(r => setTimeout(r, 100));
  const c = await client(port, { type: 'hello', pass: 'ok', mode: 'family', trio: true });
  const rd = await c.until(m => m.type === 'ready'); assert.strictEqual(rd.trio, true);
  c.ws.send(JSON.stringify({ type: 'text', text: 'バターちゃん、今日の天気は？' }));
  await new Promise(r => setTimeout(r, 150));
  assert.ok(!c.msgs.some(m => m.type === 'reply_start'), '呼ばれていないので答えない');
  let sys = '';
  const origStream = deps.claude.messages.stream;
  deps.claude.messages.stream = p => { sys = sysText(p.system); lastMessages = p.messages; return origStream(p); };
  c.ws.send(JSON.stringify({ type: 'text', text: 'ジュニア、どう思う？' }));
  await c.until(m => m.type === 'reply_end');
  assert.ok(/バターちゃんジュニア/.test(sys) && /三人モード/.test(sys), 'ジュニアとして三人モードで話す');
  assert.ok(/今日の天気/.test(lastMessages[lastMessages.length - 1].content[0].text), 'まわりの会話も渡す');
  c.ws.send(JSON.stringify({ type: 'text', text: 'ジュニア、もっと間をあけて' }));
  const tr = await c.until(m => m.type === 'trio' && m.waitMs > 700);
  assert.strictEqual(tr.waitMs, 1300);
  // 三人モードは2文まで
  await new Promise(r => setTimeout(r, 300));
  const g0 = Math.max(0, ...c.msgs.filter(m => m.gen != null).map(m => m.gen));
  c.ws.send(JSON.stringify({ type: 'text', text: 'ジュニア、お話しして' }));
  const s2 = await c.until(m => m.type === 'reply_start' && m.gen > g0);
  const e2 = await c.until(m => m.type === 'reply_end' && m.gen === s2.gen);
  const au = c.msgs.filter(m => m.type === 'audio' && m.gen === e2.gen);
  assert.ok(au.length >= 1 && au.length <= 2, '2文まで: ' + au.length);
  // 呼ばれたあと、ほかの人が話しても返事はやめない（待ってから話す）
  c.ws.send(JSON.stringify({ type: 'text', text: 'ジュニア、どうかな？' }));
  const st = await c.until(m => m.type === 'reply_start' && m.gen > e2.gen);
  c.ws.send(JSON.stringify({ type: 'text', text: 'あの子の返事を待ってるね' }));
  await c.until(m => m.type === 'audio' && m.gen === st.gen, 5000);
  c.ws.send(JSON.stringify({ type: 'text', text: 'ジュニアって呼んだときだけ答えるんだね' }));
  await new Promise(r => setTimeout(r, 150));
  const nStart = c.msgs.filter(m => m.type === 'reply_start').length;
  c.ws.send(JSON.stringify({ type: 'text', text: 'ジャム猫、商売のコツは？' }));
  const js = await c.until(m => m.type === 'reply_start' && m.as === 'ジャム猫');
  assert.strictEqual(c.msgs.filter(m => m.type === 'reply_start').length, nStart + 1, '話の中の名前では答えない');
  await c.until(m => m.type === 'reply_end' && m.gen === js.gen);
  assert.ok(/ジャム猫として答える/.test(sys), 'ジャム猫として');
  // 三人モード中に「三人モード」「ふたりモード」と話に出ても切りかわらない
  c.ws.send(JSON.stringify({ type: 'text', text: '三人モードがオフかも。ふたりモードにする？' }));
  await new Promise(r => setTimeout(r, 120));
  assert.ok(!c.msgs.some(m => m.type === 'trio' && m.on === false), '名前なしでは切りかわらない');
  // あいさつ：三人モードは言わない／大人には大人向け
  const d = await client(port, { type: 'hello', pass: 'ok', trio: true, greet: true });
  await d.until(m => m.type === 'ready'); await new Promise(r => setTimeout(r, 100));
  assert.ok(!d.msgs.some(m => m.type === 'reply_start'), '三人モードはあいさつしない');
  const e = await client(port, { type: 'hello', pass: 'ok', trio: false, greet: true });
  const eg = await e.until(m => m.type === 'reply_end');
  assert.ok(/パパ/.test(eg.text) && !/宿題/.test(eg.text), '大人向けのあいさつ: ' + eg.text);
  c.ws.send(JSON.stringify({ type: 'text', text: 'ジュニア、ふたりモードにして' }));
  await c.until(m => m.type === 'trio' && m.on === false);
  deps.claude.messages.stream = origStream;

  // GASが失敗しても切れずに話せる
  const f = await client(port, { type: 'hello', pass: 'flaky', trio: true });
  await f.until(m => m.type === 'ready');
  assert.ok(f.msgs.some(m => m.type === 'notice' && m.why === 'brain'));
  f.ws.send(JSON.stringify({ type: 'text', text: 'ジュニア、こんばんは' }));
  await f.until(m => m.type === 'reply_end');

  // 呼ばれただけなら、すぐ一言（Claudeにきかない）
  const q = await client(port, { type: 'hello', pass: 'ok', trio: false });
  await q.until(m => m.type === 'ready');
  let streamed = 0; const os2 = deps.claude.messages.stream;
  deps.claude.messages.stream = p => { streamed++; sys = sysText(p.system); return os2(p); };
  q.ws.send(JSON.stringify({ type: 'text', text: 'ジュニア、聞いてる？' }));
  const qe = await q.until(m => m.type === 'reply_end');
  assert.ok(/てやんでぃ/.test(qe.text) && streamed === 0, '名前だけはすぐ返事');
  q.ws.send(JSON.stringify({ type: 'text', text: '気合い入れていくぞー！' }));
  const kg = await q.until(m => m.type === 'reply_end' && /バターッ/.test(m.text));
  assert.ok(/根性があれば/.test(kg.text), '家族の掛け声');
  // 話したことは、切っても次につづく（まとめ・ジュニア日記）
  const qn = q.msgs.filter(m => m.type === 'reply_end').length;
  q.ws.send(JSON.stringify({ type: 'text', text: 'ピョン吉のトレーナー買ったよ' }));
  await q.until(() => q.msgs.filter(m => m.type === 'reply_end').length > qn);
  assert.ok(/いまの時刻/.test(sys) && /一人称は「おいら」/.test(sys), '時刻と話し方');
  q.ws.send(JSON.stringify({ type: 'text', text: 'こんどスマホを入れるんだ' }));
  await new Promise(r => setTimeout(r, 900));
  q.ws.close();
  await new Promise(r => setTimeout(r, 300));
  assert.ok(gasCalls.some(c => c.action === 'note' && /トレーナー/.test(c.text)), 'ジュニア日記をGASへ');
  const q2 = await client(port, { type: 'hello', pass: 'ok', trio: false });
  await q2.until(m => m.type === 'ready');
  q2.ws.send(JSON.stringify({ type: 'text', text: 'さっきの話おぼえてる？' }));
  await q2.until(m => m.type === 'reply_end');
  assert.ok(/前回までの話のまとめ/.test(sys) && /トレーナー/.test(sys), 'まとめを読んでつづきから');
  assert.ok(lastMessages.some(m => m.role === 'user' && /ピョン吉/.test(typeof m.content === 'string' ? m.content : '')), 'さいきんのやりとりもつづく');
  deps.claude.messages.stream = os2;

  // 返事の作成が1回失敗しても、2回目で答える。空の返事は記録しない
  let failOnce = true; const os3 = deps.claude.messages.stream;
  deps.claude.messages.stream = p => { if (failOnce) { failOnce = false; return { async *[Symbol.asyncIterator]() { throw new Error('boom 500'); } }; } return os3(p); };
  const rt = await client(port, { type: 'hello', pass: 'ok', trio: false });
  await rt.until(m => m.type === 'ready');
  rt.ws.send(JSON.stringify({ type: 'text', text: 'こんばんは' }));
  const re2 = await rt.until(m => m.type === 'reply_end');
  assert.ok(re2.text, '2回目で答える');
  deps.claude.messages.stream = os3;

  // 窓口：家族以外は家族の記録を読まず、案件メモをヒロさんへ
  const gst = await client(port, { type: 'hello', idToken: 'guest-x', ref: 'mac', greet: true });
  const gr = await gst.until(m => m.type === 'ready');
  assert.ok(gr.guest && !gr.trio, '窓口モード');
  const gg = await gst.until(m => m.type === 'reply_end');
  gst.ws.send(JSON.stringify({ type: 'plan', plan: 'super' }));
  await new Promise(r => setTimeout(r, 300));
  assert.ok(!gst.msgs.some(m => m.type === 'plan'), '窓口からはプランを切りかえられない');
  assert.ok(/マー君さん/.test(gg.text) && /ヒロさんに伝える/.test(gg.text), 'はじめに伝わることを知らせる: ' + gg.text);
  const os4 = deps.claude.messages.stream; let gsys = '';
  deps.claude.messages.stream = p => { gsys = sysText(p.system); return os4(p); };
  gst.ws.send(JSON.stringify({ type: 'text', text: '宿の予約の仕組みを相談したい' }));
  await gst.until(m => m.type === 'reply_end' && m.gen > gg.gen);
  assert.ok(/ヒロさんの窓口/.test(gsys) && /11\/20/.test(gsys) && !/家族OSの記録/.test(gsys), '窓口の人格・空き時間・家族の記録なし');
  gst.ws.send(JSON.stringify({ type: 'text', text: 'ヒロさんに伝えて' }));
  await new Promise(r => setTimeout(r, 600));
  const ld = gasCalls.find(c => c.action === 'lead');
  assert.ok(ld && ld.lead.ref === 'mac' && ld.lead.who === 'マー君' && ld.lead.slot && ld.lead.slot.start, '案件メモ（紹介元・候補日つき）');
  assert.ok(!gasCalls.some(c => c.action === 'log' && /宿の予約/.test(c.said || '')), '窓口の会話は家族の記録に入れない');
  deps.claude.messages.stream = os4;

  // 紹介のつながり：マー君（mac経由）が紹介した人の案件メモに「マー君さん（← mac）」
  const myRef = gr.myRef; assert.ok(/^[a-z0-9]{6}$/.test(myRef), '自分の紹介コード');
  const gy = await client(port, { type: 'hello', idToken: 'guest-y', ref: myRef });
  await gy.until(m => m.type === 'ready');
  const nL = gasCalls.filter(c => c.action === 'lead').length;
  gy.ws.send(JSON.stringify({ type: 'text', text: 'ヒロさんに相談したい' }));
  await gy.until(m => m.type === 'reply_end');
  gy.ws.send(JSON.stringify({ type: 'text', text: 'よろしく伝えて' }));
  await new Promise(r => setTimeout(r, 600));
  const ly = gasCalls.filter(c => c.action === 'lead')[nL];
  assert.ok(ly && /マー君さん（← mac）/.test(ly.lead.ref), '紹介のつながり: ' + (ly && ly.lead.ref));
  // 窓口を止めているとき
  const gc = await client(port, { type: 'hello', idToken: 'guest-closed' });
  await gc.until(m => m.type === 'error' && m.code === 'closed');

  // いいとこ取り：天気は賢いモデル＋検索、ふつうのおしゃべりは速いモデル
  let lastParams = null; const os5 = deps.claude.messages.stream;
  deps.claude.messages.stream = p => { lastParams = p; return os5(p); };
  const w = await client(port, { type: 'hello', pass: 'ok', trio: false });
  await w.until(m => m.type === 'ready');
  w.ws.send(JSON.stringify({ type: 'text', text: '明日の天気は？' }));
  await w.until(m => m.type === 'searching');
  await w.until(m => m.type === 'reply_end');
  assert.ok(lastParams.model === 'claude-sonnet-5-5' && lastParams.tools && lastParams.tools[0].name === 'web_search', '調べもの');
  assert.ok(/想像で答えない/.test(sysText(lastParams.system)), '正直に');
  const wn = w.msgs.filter(m => m.type === 'reply_end').length;
  w.ws.send(JSON.stringify({ type: 'text', text: 'こんばんは' }));
  await w.until(() => w.msgs.filter(m => m.type === 'reply_end').length > wn);
  assert.ok(lastParams.model === 'claude-haiku-5-5' && !lastParams.tools, 'ふだんは速いモデル');
  // 料金プランのおためし：家族の画面は切りかえられる（スーパー上位は一番賢いモデル＋長い記憶）、窓口からは受けつけない
  w.ws.send(JSON.stringify({ type: 'plan', plan: 'super' }));
  const pl = await w.until(m => m.type === 'plan');
  assert.ok(pl.plan === 'super' && pl.label === 'スーパー上位', 'プラン切りかえ');
  const wnP = w.msgs.filter(m => m.type === 'reply_end').length;
  w.ws.send(JSON.stringify({ type: 'text', text: 'こんばんは' }));
  await w.until(() => w.msgs.filter(m => m.type === 'reply_end').length > wnP);
  const pe = w.msgs.filter(m => m.type === 'reply_end').pop();
  assert.ok(lastParams.model === 'claude-opus-5-5' && lastParams.max_tokens > 320 && pe.usage && pe.usage.plan === 'スーパー上位', 'スーパー上位は一番賢いモデル');
  assert.ok(Array.isArray(lastParams.system) && lastParams.system[0].cache_control && /バターちゃんジュニア/.test(lastParams.system[0].text), 'システムの前半はキャッシュ');
  w.ws.send(JSON.stringify({ type: 'plan', plan: 'std' }));
  await w.until(m => m.type === 'plan' && m.plan === 'std');
  // 近くを聞かれたら、スマホの位置（およそ）を基準に
  w.ws.send(JSON.stringify({ type: 'loc', lat: 35.6, lon: 139.61 }));
  const wn2 = w.msgs.filter(m => m.type === 'reply_end').length;
  w.ws.send(JSON.stringify({ type: 'text', text: '近くのラーメン屋は？' }));
  await w.until(() => w.msgs.filter(m => m.type === 'reply_end').length > wn2, 8000);
  assert.ok(/いまいる場所/.test(sysText(lastParams.system)) && lastParams.tools, '近くは位置を基準に調べる');
  deps.claude.messages.stream = os5;

  // 11こ：覚える・メールはヒロさんだけ・議事録（文字とPDF）・窓口の役割と相談メモ・写真の保存・調べた先のリンク・質問のあとの続き
  {
    const f = await client(port, { type: 'hello', pass: 'ok', mode: 'family' });
    await f.until(m => m.type === 'ready');
    let sy = ''; const o = deps.claude.messages.stream;
    deps.claude.messages.stream = p => { sy = sysText(p.system); lastMessages = p.messages; return o(p); };
    f.ws.send(JSON.stringify({ type: 'text', text: 'ジュニア、カイトの好きなポケモンはピカチュウって覚えて' }));
    await f.until(m => m.type === 'reply_end' && /覚えたぜ/.test(m.text || ''));
    f.ws.send(JSON.stringify({ type: 'text', text: 'カイトの好きなのは？' }));
    await f.until(m => m.type === 'reply_end' && !/覚えた/.test(m.text || ''));
    assert.ok(/教わったこと/.test(sy) && /ピカチュウ/.test(sy), '教わったことを使う');
    assert.ok(/自分で気づいたこと/.test(sy) && /家族の人数/.test(sy), '自分で気づいたことを次に生かす');
    assert.ok(/かたい敬語は使わない/.test(sy), 'いつも江戸っ子');
    f.ws.send(JSON.stringify({ type: 'text', text: '英語の宿題、りんごってなんて書くの？' }));
    await f.until(m => m.type === 'reply_end' && m.gen > 0 && /勉強を教える/.test(sy));
    f.ws.send(JSON.stringify({ type: 'text', text: 'メール来てる？' }));
    await f.until(m => m.type === 'reply_end' && /ヒロさんにしか/.test(m.text || ''));
    const h = await client(port, { type: 'hello', idToken: 'tok-b', mode: 'family' });
    await h.until(m => m.type === 'ready');
    const nlog = gasCalls.filter(c => c.action === 'log').length;
    h.ws.send(JSON.stringify({ type: 'text', text: 'メール来てる？' }));
    await h.until(m => m.type === 'reply_end' && !/ヒロさんにしか/.test(m.text || ''));
    assert.ok(/清掃シートの件/.test(JSON.stringify(lastMessages[lastMessages.length - 1])), 'ヒロさんにはメールを渡す');
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(gasCalls.filter(c => c.action === 'log').length, nlog, 'メールは記録しない');
    f.ws.send(JSON.stringify({ type: 'text', text: '議事録を作って' }));
    const lk = await f.until(m => m.type === 'links' && /議事録/.test(m.links[0].title));
    assert.ok(gasCalls.some(c => c.action === 'minutes' && c.text && /^\d{4}-/.test(c.title)), '議事録をGASへ');
    assert.ok(gasCalls.some(c => c.action === 'minutes' && c.pdf === false), 'ふだんは文字の議事録');
    f.ws.send(JSON.stringify({ type: 'text', text: '議事録をPDFにして' }));
    await f.until(m => m.type === 'links' && /PDF/.test(m.links[0].title));
    assert.ok(gasCalls.some(c => c.action === 'minutes' && c.pdf === true), '頼まれたらPDF');
    // 窓口の役割と相談メモ
    let gs = ''; const o2 = deps.claude.messages.stream;
    deps.claude.messages.stream = p => { gs = sysText(p.system); return o2(p); };
    const gx = await client(port, { type: 'hello', idToken: 'guest-x', ref: 'macpmo' });
    await gx.until(m => m.type === 'ready');
    gx.ws.send(JSON.stringify({ type: 'text', text: 'この前の続きなんだけど' }));
    await gx.until(m => m.type === 'reply_end');
    assert.ok(!/勉強を教える/.test(gs), '窓口は勉強モードにしない'); assert.ok(/便利屋/.test(gs) && /介護/.test(gs) && !/【家族の画面】/.test(gs), '窓口は事例案内'); assert.ok(/役割：サポート/.test(gs) && /役割：コンサル相談/.test(gs) && /AirHost/.test(gs) && /恋の話/.test(gs), '役割と相談メモ');
    deps.claude.messages.stream = o2; gx.ws.close();
    // 相談メモがある人は、開いたら振り返りからはじめる
    let recapSys = ''; const oc = deps.claude.messages.create;
    deps.claude.messages.create = p => { if (/ページを開いた/.test(JSON.stringify(p.messages))) recapSys = p.system; return oc(p); };
    const gr = await client(port, { type: 'hello', idToken: 'guest-x', ref: 'macpmo', greet: true });
    const rg = await gr.until(m => m.type === 'reply_end' && m.text);
    assert.ok(!/ヒロさんの相棒、バターちゃんジュニアだぜ/.test(rg.text), '振り返りのあいさつ');
    assert.ok(/AirHost/.test(recapSys) && !/前回までの話のまとめ/.test(recapSys), '振り返りは相談メモだけ');
    deps.claude.messages.create = oc;
    gr.ws.close();
    f.ws.send(JSON.stringify({ type: 'save_media', kind: 'photo', mime: 'image/jpeg', data: 'data:image/jpeg;base64,AAAA' }));
    await f.until(m => m.type === 'links' && /写真/.test(m.links[0].title));
    // 調べた先のリンク
    deps.claude.messages.stream = p => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'content_block_start', content_block: { type: 'web_search_tool_result', content: [{ url: 'https://tenki.jp/x', title: 'tenki.jp' }] } };
      for (const ch of ['あしたは', '晴れだぜ。']) yield { type: 'content_block_delta', delta: { type: 'text_delta', text: ch } };
    } });
    f.ws.send(JSON.stringify({ type: 'text', text: 'あしたの天気を調べて' }));
    const ln = await f.until(m => m.type === 'links' && m.links.some(x => /tenki/.test(x.url)));
    // 調べものが区切られた（pause_turn）ら続きをもらう・空っぽならやり直す
    let calls = 0, contMsgs = null;
    deps.claude.messages.stream = p => { calls++; const c = calls; if (c === 2) contMsgs = p.messages; return Object.assign({ async *[Symbol.asyncIterator]() {
      if (c === 1) { yield { type: 'message_delta', delta: { stop_reason: 'pause_turn' } }; return; }
      if (c === 2) { yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } }; return; }   // 空っぽ
      for (const ch of ['駅のそばに', 'あるぜ。']) yield { type: 'content_block_delta', delta: { type: 'text_delta', text: ch } };
    } }, { finalMessage: async () => ({ content: [{ type: 'server_tool_use', id: 'x', name: 'web_search', input: { query: 'ラーメン' } }] }) }); };
    f.ws.send(JSON.stringify({ type: 'text', text: '近くのラーメン屋を調べて' }));
    await f.until(m => m.type === 'reply_end' && /駅のそば/.test(m.text || ''), 6000);
    assert.ok(calls === 3 && contMsgs[contMsgs.length - 1].role === 'assistant', '区切られたら続きを、空ならやり直し');
    // 上限で切れた文は読まない・家族の画面は家族の話をしてよい・自分で気づいたことを次に生かす
    deps.claude.messages.stream = p => { sy = sysText(p.system); return { async *[Symbol.asyncIterator]() {
      for (const ch of ['6人家族だぜ。', 'パパとママと、子ども', 'が4人']) yield { type: 'content_block_delta', delta: { type: 'text_delta', text: ch } };
      yield { type: 'message_delta', delta: { stop_reason: 'max_tokens' } };
    } }; };
    f.ws.send(JSON.stringify({ type: 'text', text: '何人家族なの？' }));
    const cutEnd = await f.until(m => m.type === 'reply_end' && /6人家族/.test(m.text || ''));
    assert.strictEqual(cutEnd.text, '6人家族だぜ。', '切れた文は出さない');
    assert.ok(!f.msgs.some(m => m.type === 'audio' && /子ども/.test(m.text)), '切れた文は読まない');
    assert.ok(/家族の画面/.test(sy) && /やったぜ/.test(sy) && !/便利屋/.test(sy), '家族の決まり・正直');
    // 三人モード：ジュニアが質問したら、つぎの1回は名前がなくても答える
    deps.claude.messages.stream = () => fakeStream('[わくわく]どれが好きなんだい？');
    const t = await client(port, { type: 'hello', pass: 'ok', mode: 'family', trio: true });
    await t.until(m => m.type === 'ready');
    t.ws.send(JSON.stringify({ type: 'text', text: 'ジュニア、なにか聞いて' }));
    const q = await t.until(m => m.type === 'reply_end');
    await new Promise(r => setTimeout(r, 1500));
    t.ws.send(JSON.stringify({ type: 'text', text: 'メロンが好き' }));
    await t.until(m => m.type === 'reply_start' && m.gen > q.gen, 12000);
    deps.claude.messages.stream = o;
    [f, h, t].forEach(x => x.ws.close());
  }
  console.log('OK：開いたら振り返り（相談メモだけ）・自分で学ぶ・切れた文は読まない・家族の画面は家族の話をする・窓口の事例案内・区切られた返事の続き・空の返事のやり直し・家族は勉強を教える・覚える・メールはヒロさんだけ・議事録（文字とPDF）・窓口の役割と相談メモ・写真の保存・調べた先のリンク・質問のあとの続き・会話・気持ち・一文ずつの声・写真・記録の分け方・ご縁つなぎ・割りこみ・三人モード・呼ばれただけ・会話のつづき・ジュニア日記・やりなおし・窓口と案件メモ・紹介のつながり・窓口のお休み・いいとこ取りと検索・近くの場所・プランのおためし');
  process.exit(0);
})().catch(e => { console.error('NG', e); process.exit(1); });
