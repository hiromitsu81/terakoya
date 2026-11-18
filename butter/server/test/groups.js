// LINEグループ：入ったら自己紹介（退出しない）、招待した人のボタン、招待コードで管理者、呼ばれたときだけ出る
'use strict';
const assert = require('assert'), crypto = require('crypto'), http = require('http');
process.env.HATABO_CHANNEL_SECRET = 'sec'; process.env.HATABO_LINE_TOKEN = 'tok'; process.env.CLAUDE_FAMILY = '0';
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
const post = (port, events) => new Promise((ok, ng) => {
  const raw = JSON.stringify({ events }), sig = crypto.createHmac('sha256', 'sec').update(raw).digest('base64');
  const r = http.request({ port, path: '/line/webhook', method: 'POST', headers: { 'x-line-signature': sig, 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', () => setTimeout(ok, 120)); });
  r.on('error', ng); r.end(raw);
});
(async () => {
  const server = createServer().listen(0), port = server.address().port;
  const src = { type: 'group', groupId: 'Cgroup1', userId: 'Uhiro' };
  await post(port, [{ type: 'join', replyToken: 'r1', source: { type: 'group', groupId: 'Cgroup1' } }]);
  const j = sent.pop(); assert.ok(/reply/.test(j.url) && j.body.messages[0].type === 'flex', '入ったらカード');
  const txt = JSON.stringify(j.body); assert.ok(/ref=g[a-z0-9]{6}/.test(txt) && /act=inviter/.test(txt), 'グループの紹介コードと招待した人のボタン');
  assert.ok(!sent.some(x => /leave/.test(x.url)), '退出しない');
  await post(port, [{ type: 'message', replyToken: 'r2', source: src, message: { type: 'text', text: 'こんばんは' } }]);
  assert.strictEqual(sent.length, 0, 'ふつうの会話には出てこない');
  await post(port, [{ type: 'message', replyToken: 'r3', source: src, message: { type: 'text', text: 'ハタボって何？' } }]);
  assert.ok(/呼んだボー/.test(JSON.stringify(sent.pop().body)), '呼ばれたら出る');
  await post(port, [{ type: 'postback', replyToken: 'r4', source: src, postback: { data: 'act=inviter' } }]);
  assert.ok(/招待した人として覚えた/.test(JSON.stringify(sent.pop().body)), '招待した人を覚える');
  await post(port, [{ type: 'postback', replyToken: 'r5', source: Object.assign({}, src, { userId: 'Uother' }), postback: { data: 'act=inviter' } }]);
  assert.ok(/別の人で登録ずみ/.test(JSON.stringify(sent.pop().body)), '2人目は登録しない');
  console.log('OK：グループに入る・退出しない・呼ばれたときだけ・招待した人・グループの紹介コード');
  server.close(); process.exit(0);
})().catch(e => { console.error('NG', e); process.exit(1); });
