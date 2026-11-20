// LINEグループ：入ったら自己紹介（退出しない）、招待した人のボタン、招待コードで管理者、呼ばれたときだけ出る
'use strict';
const assert = require('assert'), crypto = require('crypto'), http = require('http');
process.env.HATABO_CHANNEL_SECRET = 'sec'; process.env.HATABO_LINE_TOKEN = 'tok'; process.env.KOMUGI_CHANNEL_SECRET = 'sec'; process.env.KOMUGI_LINE_TOKEN = 'ktok'; process.env.CLAUDE_FAMILY = '0';
const sent = [], realFetch = global.fetch;
global.fetch = async (url, opt) => {
  url = String(url);
  if (url.startsWith('https://api.line.me/')) {
    if (/\/member\/|\/profile\//.test(url)) return { json: async () => ({ displayName: 'ヒロ' }) };
    sent.push({ url, body: JSON.parse(opt.body) }); return { json: async () => ({}) };
  }
  return realFetch(url, opt);
};
const { createServer, deps } = require('../server.js'); deps.db = false;
const post = (port, events, path = '/line/webhook') => new Promise((ok, ng) => {
  const raw = JSON.stringify({ events }), sig = crypto.createHmac('sha256', 'sec').update(raw).digest('base64');
  const r = http.request({ port, path, method: 'POST', headers: { 'x-line-signature': sig, 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', () => setTimeout(ok, 120)); });
  r.on('error', ng); r.end(raw);
});
(async () => {
  const server = createServer().listen(0), port = server.address().port;
  const src = { type: 'group', groupId: 'Cgroup1', userId: 'Uhiro' };
  await post(port, [{ type: 'join', replyToken: 'r1', source: { type: 'group', groupId: 'Cgroup1' } }]);
  const j = sent.pop(); assert.ok(/reply/.test(j.url) && j.body.messages[0].type === 'flex', '入ったらカード');
  const txt = JSON.stringify(j.body); assert.ok(/ref=g[a-z0-9]{6}/.test(txt) && /act=inviter/.test(txt), 'グループの紹介コードと招待した人のボタン');
  assert.ok(!sent.some(x => /leave/.test(x.url)), '退出しない');
  const v = j.body.messages.find(m => m.type === 'video'); assert.ok(v && /^https:\/\/.+\/cm\/hatabo_cm\.mp4$/.test(v.originalContentUrl) && /\.jpg$/.test(v.previewImageUrl), 'グループに入ったらCM動画もそえる');
  await post(port, [{ type: 'message', replyToken: 'r2', source: src, message: { type: 'text', text: 'こんばんは' } }]);
  assert.strictEqual(sent.length, 0, 'ふつうの会話には出てこない');
  await post(port, [{ type: 'message', replyToken: 'r3', source: src, message: { type: 'text', text: 'ハタボって何？' } }]);
  assert.ok(/呼びましたか/.test(JSON.stringify(sent.pop().body)), '呼ばれたら出る');
  await post(port, [{ type: 'postback', replyToken: 'r4', source: src, postback: { data: 'act=inviter' } }]);
  assert.ok(/招待した人として覚えました/.test(JSON.stringify(sent.pop().body)), '招待した人を覚える');
  await post(port, [{ type: 'postback', replyToken: 'r5', source: Object.assign({}, src, { userId: 'Uother' }), postback: { data: 'act=inviter' } }]);
  assert.ok(/別の人で登録ずみ/.test(JSON.stringify(sent.pop().body)), '2人目は登録しない');
  await post(port, [{ type: 'postback', replyToken: 'r7', source: src, postback: { data: 'act=rec_on' } }]);
  assert.ok(/管理者だけ/.test(JSON.stringify(sent.pop().body)), '記録は管理者だけ');
  await post(port, [{ type: 'message', replyToken: 'r8', source: src, message: { type: 'text', text: 'ハタボ、記録して' } }]);
  assert.ok(/act=rec_on/.test(JSON.stringify(sent.pop().body)), '記録のボタンを出す');
  assert.ok(/招待コードを出す/.test(txt) && /act=rec_on/.test(txt), '入ったときのカードに、コードの貼り方と記録のボタン');
  await post(port, [{ type: 'join', replyToken: 'k1', source: { type: 'group', groupId: 'Ck' } }], '/line/webhook/komugi');
  const kj = JSON.stringify(sent.pop().body); assert.ok(/コムギが入りました/.test(kj) && /2012686672/.test(kj) && !/ボー/.test(kj), 'コムギの公式LINEはコムギの言葉とミニアプリ: ' + kj.slice(0, 300));
  assert.ok(/komugi_face\.jpg/.test(kj) && /#FF2E9A/.test(kj) && !/#16233F/.test(kj), 'コムギのカードは黒とネオン・コムギの顔');
  assert.ok(!/"type":"video"/.test(kj), 'コムギはCM動画を出さない');
  require('fs').writeFileSync('/tmp/kj.json', kj);
  await post(port, [{ type: 'message', replyToken: 'k2', source: { type: 'group', groupId: 'Ck', userId: 'U1' }, message: { type: 'text', text: 'コムギちゃんおる？' } }], '/line/webhook/komugi');
  assert.ok(/呼びましたか/.test(JSON.stringify(sent.pop().body)), 'コムギと呼ばれたら出る');
  await post(port, [{ type: 'follow', replyToken: 'f1', source: { type: 'user', userId: 'Unew' } }]);
  { const fb = sent.filter(x => /reply/.test(x.url)).pop().body; assert.ok(fb.messages.length === 2 && fb.messages[1].type === 'video', '友だち追加のあいさつにCM動画'); }
  console.log('OK：グループに入る・退出しない・呼ばれたときだけ・招待した人・グループの紹介コード・あいさつのCM動画');
  server.close(); process.exit(0);
})().catch(e => { console.error('NG', e); process.exit(1); });
