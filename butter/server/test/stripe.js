// 決済（Stripe）のテスト：署名、支払いが済んだ知らせ → 契約、同じ知らせは1回、支払いの失敗、お試し終了、支払いページ
const http = require('http'), crypto = require('crypto'), assert = require('assert');
const calls = [];
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    calls.push({ url: req.url, body: b, auth: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/v1/prices') && /lookup_keys/.test(req.url)) return res.end(JSON.stringify({ data: /ris_Z_m/.test(decodeURIComponent(req.url)) ? [{ id: 'price_risZm' }] : [] }));
    if (req.url.startsWith('/v1/prices')) return res.end(JSON.stringify({ data: [{ id: 'price_boraGy', recurring: { interval: 'year' }, product: { name: 'ハタボーラ G（会社の愛棒・1席）', active: true } }, { id: 'price_boraGm', recurring: { interval: 'month' }, product: { name: 'ハタボーラ G（会社の愛棒・1席）', active: true } }] }));
    if (req.url.startsWith('/v1/checkout/sessions')) return res.end(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' }));
    res.statusCode = 404; res.end('{}');
  });
});
mock.listen(0, async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'; process.env.STRIPE_API = 'http://127.0.0.1:' + mock.address().port;
  const srv = require('../server');
  try {
    // 署名
    const raw = JSON.stringify({ id: 'evt_x' }), t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_test').update(t + '.' + raw).digest('hex');
    assert.ok(srv.stripeSigOk(raw, 't=' + t + ',v1=' + sig), '正しい署名');
    assert.ok(!srv.stripeSigOk(raw, 't=' + t + ',v1=' + sig.replace(/.$/, c => c === 'a' ? 'b' : 'a')), 'ちがう署名');
    assert.ok(!srv.stripeSigOk(raw, 't=' + (t - 600) + ',v1=' + crypto.createHmac('sha256', 'whsec_test').update((t - 600) + '.' + raw).digest('hex')), '古い署名');
    // お試しが終わって支払いがない → expired、支払い済み → contract
    assert.strictEqual(srv.funnelOf({ stage: 'trial', trialUntil: Date.now() - 1000 }).stage, 'expired', 'お試し終了');
    assert.strictEqual(srv.funnelOf({ stage: 'trial', trialUntil: Date.now() - 1000, paidAt: 1 }).stage, 'contract', '支払い済みなら契約');
    // 支払いが済んだ知らせ → 契約
    await srv.putRef('tst1', { owner: 'g:t1', name: 'テスト', stage: 'cancel' });
    const ev = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { client_reference_id: 'tst1', customer: 'cus_1', subscription: 'sub_1', metadata: { myRef: 'tst1', lineup: 'ris', grade: 'Z', pay: 'm', name: 'テスト' } } } };
    assert.strictEqual(await srv.handleStripeEvent(ev), 'contract');
    const r = await srv.getRef('tst1');
    assert.ok(r.stage === 'contract' && r.paidAt && r.stripeCustomer === 'cus_1' && r.grade === 'Z', '契約になった ' + JSON.stringify(r));
    assert.strictEqual(await srv.handleStripeEvent(ev), 'dup', '同じ知らせは1回');
    // お試し中に支払い登録 → お試しのまま、終わったら契約
    await srv.putRef('tst2', { owner: 'g:t2', stage: 'trial', trialUntil: Date.now() + 3 * 86400000, lineup: 'ris', grade: 'Z' });
    await srv.handleStripeEvent({ id: 'evt_2', type: 'checkout.session.completed', data: { object: { customer: 'cus_2', metadata: { myRef: 'tst2', lineup: 'ris', grade: 'Z', pay: 'm' } } } });
    const r2 = await srv.getRef('tst2');
    assert.ok(r2.stage === 'trial' && r2.paidAt, 'お試し中の支払い登録');
    // 支払いの失敗・解約
    assert.strictEqual(await srv.handleStripeEvent({ id: 'evt_3', type: 'invoice.payment_failed', data: { object: { customer: 'cus_1' } } }), 'failed');
    assert.ok((await srv.getRef('tst1')).payFailAt, '支払いの失敗を記録');
    assert.strictEqual(await srv.handleStripeEvent({ id: 'evt_4', type: 'customer.subscription.deleted', data: { object: { customer: 'cus_1' } } }), 'canceled');
    assert.strictEqual((await srv.getRef('tst1')).stage, 'cancel', '解約');
    // 支払いページ：価格の lookup_key でさがして、お試し中は引き落としを後ろに
    const url = await srv.checkoutFor({ myRef: 'tst2', me: 'テスト', avatar: 'hatabo' }, await srv.getRef('tst2'), { lineup: 'ris', grade: 'Z', pay: 'm', stage: 'trial' });
    assert.strictEqual(url, 'https://checkout.stripe.test/cs_1');
    const cs = calls.find(c => c.url.startsWith('/v1/checkout/sessions'));
    assert.ok(/price_risZm/.test(cs.body) && /trial_end/.test(decodeURIComponent(cs.body)) && /client_reference_id=tst2/.test(cs.body) && cs.auth === 'Bearer sk_test_x', '支払いページの中身 ' + decodeURIComponent(cs.body).slice(0, 300));
    assert.strictEqual(await srv.checkoutFor({ myRef: 'x' }, {}, { lineup: 'box', grade: 'G', pay: 'm' }), null, '価格がないプランは支払いページなし');
    assert.ok(await srv.checkoutFor({ myRef: 'x', avatar: 'hatabo' }, {}, { lineup: 'bora', grade: 'G', pay: 'y' }), '商品名でさがす');
    assert.ok(calls.some(c => /price_boraGy/.test(c.body)), '年払いの価格を選ぶ');
    console.log('OK：商品名・署名・契約・二重の知らせ・お試し中の支払い登録・支払いの失敗・解約・支払いページ');
    process.exit(0);
  } catch (e) { console.error('NG', e); process.exit(1); }
});
