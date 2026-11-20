// AIアプリの一覧に出すためのOAuth（DCR・PKCE・デモ・LINEでつなぐ・ChatGPTは料金なし）
'use strict';
const http = require('http'), assert = require('assert'), crypto = require('crypto'), WebSocket = require('ws'), { EventEmitter } = require('events');
const gasSrv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
  const j = JSON.parse(b); res.setHeader('Content-Type', 'application/json');
  if (j.action === 'brain') return res.end(JSON.stringify(j.idToken === 'own' ? { ok: true, guest: true, owner: 'g:Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', me: 'ヒロ', role: '汎用', slots: [] } : { ok: false, error: 'auth' }));
  res.end(JSON.stringify({ ok: true }));
}); }).listen(0);
process.env.GAS_URL = 'http://127.0.0.1:' + gasSrv.address().port;
process.env.WEB_SECRET = 'test-secret'; process.env.DEMO_PASS = 'demo-pass-123'; process.env.MCP_BASE = 'https://mcp.example.test';
const { createServer, deps } = require('../server.js');
const fake = t => ({ async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: t } }; yield { type: 'message_stop' }; }, finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }], usage: {} }) });
deps.claude = { messages: { stream: () => fake('こんにちは。'), create: async () => ({ content: [{ type: 'text', text: '{}' }], usage: {} }) } };
deps.tts = { synthesizeSpeech: async () => [{ audioContent: Buffer.from('x') }] };
deps.stt = { streamingRecognize: () => { const e = new EventEmitter(); e.write = () => {}; e.end = () => {}; return e; } };
deps.db = false;
(async () => {
  const server = createServer().listen(0), B = 'http://127.0.0.1:' + server.address().port;
  const get = (p, o) => fetch(B + p, Object.assign({ redirect: 'manual' }, o || {}));
  const form = (p, f, h) => get(p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, h || {}), body: new URLSearchParams(f).toString() });
  let id = 1; const rpc = async (tok, method, params) => { const r = await get('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) }); return { status: r.status, h: r.headers, j: await r.json().catch(() => null) }; };
  // 1. 案内（メタデータ）と、印がないときの401
  const am = await (await get('/.well-known/oauth-authorization-server')).json();
  assert.ok(am.issuer === 'https://mcp.example.test' && am.code_challenge_methods_supported.includes('S256') && am.registration_endpoint && am.client_id_metadata_document_supported, '認可サーバーの案内');
  const pr = await (await get('/.well-known/oauth-protected-resource/mcp')).json();
  assert.ok(pr.resource === 'https://mcp.example.test/mcp' && pr.authorization_servers[0] === am.issuer, '守られた資源の案内');
  const no = await rpc('x', 'tools/list', {});
  assert.ok(no.status === 401 && /resource_metadata=/.test(no.h.get('www-authenticate')), '印がないと401と案内の住所');
  // 2. 自動登録（DCR）
  const reg = async (name, ru) => (await get('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: [ru], token_endpoint_auth_method: 'none' }) })).json();
  const bad = await get('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
  assert.strictEqual(bad.status, 400, 'httpのもどり先（localhost以外）は断る');
  const cC = await reg('Claude', 'https://claude.ai/api/mcp/auth_callback');
  assert.ok(/^hbcli_/.test(cC.client_id) && !cC.client_secret, '登録できる');
  // 3. つなぐ流れ：PKCEなしは断る → デモでログイン → 許可 → code → 印
  const ver = crypto.randomBytes(40).toString('base64url'), ch = crypto.createHash('sha256').update(ver).digest('base64url');
  const authz = (c, ru, pkce) => get('/oauth/authorize?' + new URLSearchParams(Object.assign({ response_type: 'code', client_id: c, redirect_uri: ru, state: 'st1', scope: 'hatabo' }, pkce ? { code_challenge: ch, code_challenge_method: 'S256' } : {})));
  const np = await authz(cC.client_id, 'https://claude.ai/api/mcp/auth_callback', false);
  assert.ok(np.status === 302 && /error=invalid_request/.test(np.headers.get('location')), 'PKCEなしは断る');
  const wr = await authz(cC.client_id, 'https://evil.example/cb', true); assert.strictEqual(wr.status, 400, 'もどり先がちがうと断る');
  const pg = await (await authz(cC.client_id, 'https://claude.ai/api/mcp/auth_callback', true)).text();
  assert.ok(/LINEでつなぐ/.test(pg) && /デモ用のアカウント/.test(pg), 'つなぐ画面（LINE・デモ）');
  const rid = pg.match(/name="rid" value="([\w-]+)"/)[1];
  assert.strictEqual((await form('/oauth/demo', { rid, user: 'demo', pass: 'wrong' })).status, 401, 'デモの合言葉がちがうと断る');
  const cons = await (await form('/oauth/demo', { rid, user: 'demo', pass: 'demo-pass-123' })).text();
  assert.ok(/を、ハタボにつなぎますか/.test(cons), 'つなぐ確認の画面');
  const t = cons.match(/name="t" value="([^"]+)"/)[1];
  const ap = await form('/oauth/approve', { t, ok: '1' }); const loc = new URL(ap.headers.get('location'));
  assert.ok(ap.status === 302 && loc.origin === 'https://claude.ai' && loc.searchParams.get('state') === 'st1' && loc.searchParams.get('iss') === am.issuer, 'もどり先へcodeを持って帰す');
  const code = loc.searchParams.get('code');
  const tok = async f => { const r = await form('/oauth/token', f); return { status: r.status, j: await r.json() }; };
  assert.strictEqual((await tok({ grant_type: 'authorization_code', code, client_id: cC.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: 'x'.repeat(43) })).status, 400, 'PKCEがちがうと断る');
  const T1 = await tok({ grant_type: 'authorization_code', code, client_id: cC.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: ver });
  assert.ok(T1.status === 200 && /^hbat_/.test(T1.j.access_token) && /^hbrt_/.test(T1.j.refresh_token) && T1.j.expires_in === 3600, '印と更新の印');
  assert.strictEqual((await tok({ grant_type: 'authorization_code', code, client_id: cC.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: ver })).status, 400, 'codeは1回だけ');
  // 4. 印でMCP：道具の印（annotations）、デモの愛棒だけ見える、料金も出る（Claude）
  const tl = await rpc(T1.j.access_token, 'tools/list', {});
  assert.ok(tl.j.result.tools.length === 6 && tl.j.result.tools.every(x => x.title && x.annotations && typeof x.annotations.readOnlyHint === 'boolean'), '道具に名前と印');
  const sr = await rpc(T1.j.access_token, 'tools/call', { name: 'search_aibo', arguments: { query: 'そば' } });
  const sc = sr.j.result.structuredContent; assert.ok(sc.found === 1 && sc.aibo[0].id === 'demo-soba' && 'yen' in sc, 'デモはデモのそば屋が見つかる');
  const my = await rpc(T1.j.access_token, 'tools/call', { name: 'list_my_aibo', arguments: {} });
  assert.strictEqual(my.j.result.structuredContent.aibo.length, 2, 'デモの愛棒の一覧');
  const rs = await rpc(T1.j.access_token, 'tools/call', { name: 'request_reservation', arguments: { aibo: 'demo-soba', when: '12月5日 19時', people: 2, name: '審査' } });
  assert.ok(rs.j.result.structuredContent.ok, 'デモのそば屋に予約の希望');
  // 5. 更新の印は入れかえない
  const T2 = await tok({ grant_type: 'refresh_token', refresh_token: T1.j.refresh_token, client_id: cC.client_id });
  assert.ok(T2.status === 200 && T2.j.refresh_token === T1.j.refresh_token && T2.j.access_token !== T1.j.access_token, '更新しても同じ更新の印');
  // 6. ChatGPT：料金を出さない。LINEでつなぐ（ミニアプリ）→ パソコンの画面が進む
  const cG = await reg('ChatGPT', 'https://chatgpt.com/connector_platform_oauth_redirect');
  const pg2 = await (await authz(cG.client_id, 'https://chatgpt.com/connector_platform_oauth_redirect', true)).text();
  const rid2 = pg2.match(/name="rid" value="([\w-]+)"/)[1];
  assert.ok((await (await get('/oauth/poll?rid=' + rid2)).json()).wait, 'まだ待つ');
  const ws = new WebSocket(B.replace('http', 'ws') + '/talk'), msgs = [];
  const until = p => new Promise((ok, ng) => { const h = msgs.find(p); if (h) return ok(h); const tm = setTimeout(() => ng(new Error('timeout')), 4000); ws.on('message', d => { const m = JSON.parse(d); if (p(m)) { clearTimeout(tm); ok(m); } }); });
  ws.on('message', d => msgs.push(JSON.parse(d)));
  await new Promise(r => ws.on('open', r)); ws.send(JSON.stringify({ type: 'hello', idToken: 'own', app: 'hatabo' })); await until(m => m.type === 'ready');
  ws.send(JSON.stringify({ type: 'oauth_info', rid: rid2 })); const inf = await until(m => m.type === 'oauth' && m.name);
  assert.strictEqual(inf.name, 'ChatGPT', 'LINEで相手の名前が出る');
  ws.send(JSON.stringify({ type: 'oauth_ok', rid: rid2 })); await until(m => m.type === 'oauth' && m.done);
  const nx = await (await get('/oauth/poll?rid=' + rid2)).json(); const l2 = new URL(nx.next);
  assert.ok(l2.hostname === 'chatgpt.com' && l2.searchParams.get('code'), 'パソコンの画面がもどり先へ進む');
  const G1 = await tok({ grant_type: 'authorization_code', code: l2.searchParams.get('code'), client_id: cG.client_id, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', code_verifier: ver });
  const tl2 = await rpc(G1.j.access_token, 'tools/list', {});
  assert.ok(!tl2.j.result.tools.some(x => x.name === 'get_usage'), 'ChatGPTには使った回数（料金）の道具を出さない');
  const s2 = await rpc(G1.j.access_token, 'tools/call', { name: 'search_aibo', arguments: { query: 'そば' } });
  assert.ok(!('yen' in s2.j.result.structuredContent) && s2.j.result.structuredContent.found === 0, 'ChatGPTの結果に円は出ない・ふつうの人にデモは見えない');
  // 7. 取り消し
  await form('/oauth/revoke', { token: T1.j.refresh_token });
  assert.strictEqual((await rpc(T2.j.access_token, 'tools/list', {})).status, 401, '取り消すと使えない');
  console.log('oauth tests passed'); ws.close(); server.close(); gasSrv.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
