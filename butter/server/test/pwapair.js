/** ホーム画面のハタボの入場券：番号を出す → LINEで本人がつなぐ → 一度だけ入場券 → 取り消し */
'use strict';
const assert = require('assert');
process.env.WEB_SECRET = process.env.WEB_SECRET || 'test-secret-for-pwa';
const S = require('../server.js');
(async () => {
  const srv = S.createServer().listen(0); await new Promise(r => srv.on('listening', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const r1 = await (await fetch(base + '/pwa/pair', { method: 'POST', headers: { Origin: 'https://app.hatha-lab.com' } })).json();
  assert.ok(/^[0-9a-f]{32}$/.test(r1.code) && /^\d{4}$/.test(r1.num), '番号が出る');
  assert.strictEqual((await (await fetch(base + '/pwa/check?c=' + r1.code)).json()).state, 'wait', 'つなぐ前は待つ');
  assert.ok(await S.pairBind(r1.code, 'g:Uabc'), 'LINEの本人がつなぐ');
  assert.strictEqual(await S.pairBind(r1.code, 'g:Uevil'), false, '二度はつなげない');
  const c1 = await (await fetch(base + '/pwa/check?c=' + r1.code)).json();
  assert.strictEqual(c1.state, 'ok'); assert.ok(c1.token, '入場券が届く');
  assert.strictEqual((await (await fetch(base + '/pwa/check?c=' + r1.code)).json()).state, 'gone', '入場券は一度だけ');
  assert.strictEqual((await (await fetch(base + '/pwa/check?c=zzz')).json()).state, 'gone', 'でたらめな番号は通らない');
  const W = S.webVerify(c1.token); assert.ok(W && W.owner === 'g:Uabc' && W.dev, '本人の入場券');
  assert.ok(await S.devOk(W)); await S.devDrop(W); assert.strictEqual(await S.devOk(W), false, 'ログアウトで取り消し');
  srv.close(); console.log('OK：ホーム画面のハタボの入場券（番号・つなぐ・一度だけ・取り消し）'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
