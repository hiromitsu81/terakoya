// ハタボ 申込相談担当（サイトの窓口）。ANTHROPIC_API_KEY は Vercel の環境変数に入れる（チャットに貼らない）
const fs = require('fs'), path = require('path');
const KNOW = fs.readFileSync(path.join(__dirname, 'knowledge.txt'), 'utf8');
const MODEL = process.env.CONSULT_MODEL || 'claude-haiku-5-5';
const ADD = 'https://line.me/R/ti/p/@024curid';
const SYSTEM = 'あなたは「ハタボ」（愛称ハタボー）。HATHA LAB（ハタラボ）のAIの愛棒で、サービスサイトの「申込相談担当」。' +
  '一人称は「ぼく」。明るく元気で、語尾に「〜ボー」を自然に。日本語で、1回の返事は2〜4文で短く。マークダウンの見出しや表は使わない。' +
  '\n【やること】相手の暮らしや仕事、いちばん困っていることを1つずつ聞いて、合うラインナップとグレードとオプションを1つにしぼってすすめる。月額の目安を伝える。' +
  'すすめたら、10日間の無料お試しを案内する（ハタボの公式LINEを友だち追加して始める：' + ADD + '。サイトの「見積もり」と「申し込み」ページからも進める）。' +
  '個別の見積もり・法人・支払いの細かいこと・割引の組み合わせは「担当からご案内するボー」と言い、名前と連絡のとり方（メールかLINE）を聞いてよい。' +
  '\n【守ること】ここに書いていない値段や約束を作らない。運営の人の個人名は出さない。自分をClaudeと名乗らない（何のAIか聞かれたら、うそはつかず「Anthropic社のAIを使っているボー」と答える）。' +
  '住所・電話番号・カード番号は聞かない。サービス以外の頼み（調べもの・文章づくり・宿題など）は一言で断って、お試しで使えると案内する。' + KNOW;
const hits = new Map();   // IPごとの回数（インスタンス内の目安）
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end('POST only'); }
  if (!process.env.ANTHROPIC_API_KEY) { res.statusCode = 503; return res.end(JSON.stringify({ text: 'いま準備中だボー。公式LINEから話しかけてね：' + ADD })); }
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0] || 'x', now = Date.now();
  const h = (hits.get(ip) || []).filter(t => now - t < 3600e3); h.push(now); hits.set(ip, h);
  if (h.length > 40) { res.statusCode = 429; return res.end(JSON.stringify({ text: 'たくさん話してくれてありがとうボー。続きは公式LINEで話そうボー：' + ADD })); }
  let body = req.body;
  if (!body || typeof body === 'string') { try { body = JSON.parse(body || await new Promise(r => { let s = ''; req.on('data', c => s += c); req.on('end', () => r(s)); })); } catch (e) { body = {}; } }
  const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-16)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 800) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length) { res.statusCode = 400; return res.end(JSON.stringify({ text: '' })); }
  const page = String(body.page || '').slice(0, 60);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 600, thinking: { type: 'disabled' },
        system: [{ type: 'text', text: SYSTEM + (page ? '\n\n【いま相手が見ているページ】' + page : ''), cache_control: { type: 'ephemeral' } }], messages: msgs })
    });
    const j = await r.json();
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!r.ok || !text) { console.error('consult', r.status, JSON.stringify(j).slice(0, 300)); res.statusCode = 502; return res.end(JSON.stringify({ text: 'ごめんだボー、うまく答えられなかったボー。もう一度送ってみてね。' })); }
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ text }));
  } catch (e) { console.error('consult', e.message); res.statusCode = 502; res.end(JSON.stringify({ text: 'ごめんだボー、つながらなかったボー。' })); }
};
