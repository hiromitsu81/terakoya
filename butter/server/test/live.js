// GPT-Live-1 の検証の入口：合言葉・回数・OpenAIへの渡し方を確かめる（OpenAIはにせもの）
'use strict';
process.env.LIVE_KEY = 'test-k'; process.env.OPENAI_API_KEY = 'sk-test'; process.env.LIVE_DAILY = '2';
const assert = require('assert');
const sent = [];
const realFetch = global.fetch;
global.fetch = async (url, opt) => {
  if (String(url).includes('/v1/live/sessions')) { sent.push(JSON.parse(opt.body)); return { ok: true, json: async () => ({ session: { id: 'sess_x' }, transport: { sdp: 'v=0 answer' } }) }; }
  return realFetch(url, opt);
};
const Orig = require('ws');
require.cache[require.resolve('ws')].exports = Object.assign(function Fake() { const E = require('events'); const e = new E(); e.send = () => {}; e.close = () => {}; return e; }, Orig);
const { createServer } = require('../server.js');
const srv = createServer().listen(0, async () => {
  const base = 'http://127.0.0.1:' + srv.address().port + '/live/session';
  const post = b => realFetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://hiromitsu81.github.io' }, body: JSON.stringify(b) });
  try {
    let r = await post({ k: 'nope', sdp: 'v=0' }); assert.strictEqual(r.status, 403);
    r = await post({ k: 'test-k', sdp: 'v=0 offer' }); assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://hiromitsu81.github.io');
    const j = await r.json(); assert.strictEqual(j.sdp, 'v=0 answer');
    const s = sent[0].session; assert.strictEqual(s.model, 'gpt-live-1'); assert.strictEqual(s.delegation.type, 'client');
    assert.ok(/ハタリス/.test(s.instructions) && /声の係/.test(s.instructions) && !/ヒロさん/.test(s.instructions));
    assert.strictEqual(sent[0].transport.sdp, 'v=0 offer');
    await post({ k: 'test-k', sdp: 'v=0' });
    r = await post({ k: 'test-k', sdp: 'v=0' }); assert.strictEqual(r.status, 429);
    console.log('OK：GPT-Live-1の入口（合言葉・ハタリスの話し方・頭はClaude・回数の上限）');
    process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
