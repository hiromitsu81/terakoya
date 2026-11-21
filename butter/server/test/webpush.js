/** ホーム画面のハタボの通知：登録・送信・使えない端末の掃除・鍵がないときは何もしない */
'use strict';
const assert = require('assert'), https = require('https'), crypto = require('crypto'), { execSync } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';   // テスト用の自分で作った証明書
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-'));
execSync('openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1 -subj /CN=127.0.0.1', { cwd: dir, stdio: 'ignore' });
const wp = require('web-push'), k = wp.generateVAPIDKeys();
process.env.VAPID_PUBLIC = k.publicKey; process.env.VAPID_PRIVATE = k.privateKey;
const S = require('../server.js');
let hits = 0, gone = false;
const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, (q, r) => { hits++; q.resume(); q.on('end', () => { r.writeHead(q.url === '/gone' ? 410 : 201); r.end(); }); }).listen(0, async () => {
  const base = 'https://127.0.0.1:' + srv.address().port, key = () => { const e = crypto.createECDH('prime256v1'); e.generateKeys(); return { p256dh: e.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') }; };
  assert.strictEqual(await S.pushAdd('r1', { endpoint: 'http://x/ok', keys: key() }, ''), false, 'httpsでない宛先は受けない');
  await S.saveCol('r1', 'push', { subs: [{ endpoint: base + '/ok', keys: key(), home: 'https://app.hatha-lab.com/?liff=1&page=talk' }, { endpoint: base + '/gone', keys: key(), home: '' }] });
  const n = await S.pushTo('r1', { title: '伝言', body: 'テスト', badge: 2 });
  assert.strictEqual(n, 1); assert.strictEqual(hits, 2);
  const left = await S.pushSubs('r1'); assert.strictEqual(left.length, 1, '410の端末は消す');
  assert.strictEqual(await S.pushTo('nobody', { title: 'x' }), 0);
  assert.ok(await S.pushAdd('r2', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: key() }, 'https://evil.example/'));
  assert.strictEqual((await S.pushSubs('r2'))[0].home, '', 'よその開き先は入れない');
  await S.inboxMine('me1', 'you1', 'こんにちは');
  const mine = await S.loadInbox('me1'); assert.ok(mine[0].mine && mine[0].read && mine[0].to === 'you1', '送った伝言も自分の箱に（既読）');
  srv.close(); console.log('OK：ホーム画面のハタボの通知（登録・送信・掃除）・送った伝言を残す'); process.exit(0);
});
