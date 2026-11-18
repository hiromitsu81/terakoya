/**
 * バターちゃんジュニア（福まねき特戦隊）のなめらか会話サーバー
 *
 *   ページ ──(WebSocket)── このサーバー ──┬─ Google 聞き取り（流しっぱなし）
 *                                          ├─ Claude（ストリーミングで返事）
 *                                          ├─ Google 読み上げ（一文ずつ）
 *                                          ├─ GAS（人格・家族OSの記録・おうち日記、本人確認）
 *                                          └─ Firestore（ご縁つなぎのプロフィール。なくても動く）
 *
 * 秘密（Cloud Run の環境変数・シークレット）：
 *   ANTHROPIC_API_KEY  サーバー専用の Claude のキー
 *   GAS_URL            家族OSのウェブアプリ（…/exec）
 * そのほか（なくてもよい）：MODEL, TTS_VOICE, TTS_RATE, ALLOWED_ORIGINS, DAILY_LIMIT
 *
 * 守っていること：
 *   ・本人確認は GAS に任せる（LINE の ID トークン、または家族の合言葉）。通らなければすぐ切る
 *   ・写真は言われたときだけ。保存しない。会話の記録は家族モードのときだけおうち日記へ
 *   ・ご縁つなぎで相手に伝えるのは、本人が「紹介してよい」と書いたことだけ
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const ENV = {
  PORT: Number(process.env.PORT || 8080),
  MODEL: process.env.MODEL || 'claude-haiku-5-5',            // ふだん：速いモデル（X）。Haiku 4.5より約10分の1の料金
  SMART_MODEL: process.env.SMART_MODEL || 'claude-sonnet-5-5',        // 調べもの・むずかしい相談：賢いモデル
  PREMIUM_MODEL: process.env.PREMIUM_MODEL || 'claude-opus-5-5',      // 料金プランのおためし（上位・スーパー上位）：いちばん賢いモデル
  WEB_SEARCH: process.env.WEB_SEARCH !== 'off',                         // ネット検索（Claudeの web_search）
  TTS_VOICE: process.env.TTS_VOICE || 'ja-JP-Chirp3-HD-Algenib',   // ジュニアの声：低めでガラガラ
  TTS_RATE: Number(process.env.TTS_RATE || 1.12),
  GAS_URL: process.env.GAS_URL || '',
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || 'https://hiromitsu81.github.io,https://app.hatha-lab.com,https://miniapp.line.me,https://liff.line.me').split(',').map(s => s.trim()).filter(Boolean),
  DAILY_LIMIT: Number(process.env.DAILY_LIMIT || 400),       // 一人1日に答える回数
  DAILY_LIMIT_GUEST: Number(process.env.DAILY_LIMIT_GUEST || 30),   // 窓口（家族以外）の1日の回数。紹介コードつき
  DAILY_LIMIT_NOREF: Number(process.env.DAILY_LIMIT_NOREF || 10),   // 紹介コードなしで来た人
  GUEST_TOTAL_LIMIT: Number(process.env.GUEST_TOTAL_LIMIT || 300),  // 窓口ぜんぶで1日に答える回数
  SESSION_MAX_MIN: Number(process.env.SESSION_MAX_MIN || 60), // 1回のつなぎっぱなしの上限
  // コムギ（マー君）：窓口の役割に「コムギ」と書いた窓口は、見た目がコムギになる
  KOMUGI_REFS: (process.env.KOMUGI_REFS || '').split(',').map(s => s.trim()).filter(Boolean),   // コムギの紹介コード（ここから来た人はコムギ通信つき）
  HATABO_VOICE: process.env.HATABO_VOICE || 'ja-JP-Chirp3-HD-Puck',   // ハタボの声：明るく元気な、ひよこの男の子（ジュニアのガラガラ声とは別）
  KOMUGI_VOICE: process.env.KOMUGI_VOICE || 'ja-JP-Chirp3-HD-Leda',   // コムギの声：高めでやわらかい少女の声
  KOMUGI_RATE: Number(process.env.KOMUGI_RATE || 1.0),   // コムギはひかえめに、少しゆっくり
  KOMUGI_NEWS_URL: process.env.KOMUGI_NEWS_URL || '',                 // コムギニュース速報の最新号（テキストかJSON {title,body}）
  CLAUDE_FAMILY: process.env.CLAUDE_FAMILY !== '0',   // 家族のジュニアは、いつもClaudeと同じ（クロードのバターちゃんと同じ）
  // Googleアカウント連携（作った資料を、本人のGoogleドライブの「ハタボ」フォルダへ）。OAuthクライアントを作って入れる
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  PUBLIC_URL: (process.env.PUBLIC_URL || 'https://butter-junior-722073142596.asia-northeast1.run.app').replace(/\/$/, ''),
  HATABO_LINE_TOKEN: process.env.HATABO_LINE_TOKEN || '',
  HATABO_CHANNEL_SECRET: process.env.HATABO_CHANNEL_SECRET || '',   // 公式LINEのWebhook（友だち追加のあいさつカード）の署名チェック用   // ハタボ公式LINE（Messaging API）。あれば、伝言をLINEにも届ける
  // 一時的にスーパー上位：LINEのユーザーID:期限（例 Uxxxx:2026-12-31）。期限を過ぎたら自動で標準にもどる
  // サイトから来た人（?ref=site など）は、汎用のハタボをスーパー上位で（長文もClaudeと同じように）
  SUPER_REFS: (process.env.SUPER_REFS || 'site').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  SUPER_OWNERS: (process.env.SUPER_OWNERS || '').split(',').map(s => s.trim()).filter(Boolean),
};
/** 期限つきでスーパー上位を使える人か */
function superUntil(owner) {
  if (!owner) return '';
  for (const x of ENV.SUPER_OWNERS) {
    // 「g:」つき（ハタボのアプリ）でも、なしでも書ける。期限は最後の「:YYYY-MM-DD」
    const mm = String(x).match(/^(.*?)(?::(\d{4}-\d{2}-\d{2}))?$/), id = (mm && mm[1] || '').replace(/^g:/, ''), until = mm && mm[2];
    if (id && (id === owner || 'g:' + id === owner) && (!until || Date.now() < new Date(until + 'T23:59:59+09:00').getTime())) return until || '無期限';
  }
  return '';
}

// 料金プランのおためし（ヒロさんの家族の画面だけ）：同じ質問を3つの賢さで聞きくらべる
//   std＝いまのまま（ふだん速いモデル、むずかしい時だけ賢いモデル）
//   high＝ぜんぶ一番賢いモデル
//   super＝一番賢いモデル＋長い記憶（会話を倍おぼえる）＋長めの答え＋検索を多めに
const PLANS = {
  std:   { label: '標準',       premium: false, turns: 12, keep: 24, extraTokens: 0,   maxUses: 3, extraSent: 0 },
  high:  { label: '上位',       premium: false, smart: true, turns: 16, keep: 32, extraTokens: 500, maxUses: 3, extraSent: 1 },   // G：賢いモデルで、少し短めに（Zの半分くらいの費用）
  super: { label: 'スーパー上位', premium: true,  turns: 24, keep: 48, extraTokens: 260, maxUses: 5, extraSent: 1, long: true },   // 長文もClaudeと同じように書ける（声は最初だけ、続きは吹き出しに）
};
/** 長い文章を頼まれたか（スーパー上位だけ、Claudeと同じように最後まで書く） */
const HIGH_RULE = '\n\n【上位グレード】ふだんの「1〜2文」より少しくわしく、要点を3〜5文で答える。理由や手順が要るときは、短い箇条で3つまで。むだな前置きや最後のあいさつは入れない。';
const LONG_RE = /(書いて|かいて|まとめて|下書き|文章|長文|長く|くわしく|詳しく|メール|企画書|提案書|レポート|報告書|議事録|手紙|原稿|説明して|一覧|リスト|比べて|くらべて)/;
const CLAUDE_RULE = '\n\n【Claudeと同じように】ふだんの「1〜2文」の決まりは使わない。Claudeと同じように、聞かれたことに合った長さと深さで、正確に、最後まで答える。短くてよいことは短く、くわしく知りたいこと・調べもの・文章・計画はしっかり。声で読むのは最初の数文だけで、続きは画面の吹き出しに出る。キャラクターの話し方（呼び方・語尾）はそのまま。';
// 聞き間違いの辞書：声の文字起こしでよく崩れる名前を、話す前に直す（ハタボ・コムギ・ラインナップ名など）
const HEAR_FIX = [
  [/(?:はたらぼ|ハタラボー|畑ラボ|旗ラボ|はたラボ)/g, 'ハタラボ'],
  [/(?:えーあいぼう|エーアイボウ|AIぼう|AIボウ|えーあい棒|エーアイ棒|AI坊|ai棒)/gi, 'AI棒'],
  [/(?:あいぼう|アイボウ|相棒)(?=(?:を|が|は|の|と)?(?:育て|選|追加|契約|プラン))/g, '愛棒'],
  [/(?:はたいえんた|ハタイエンター|畑井エンタ|はたいenta)/gi, 'ハタイエンタ'],
  [/(?:はたりす|ハタリスー|畑リス)/g, 'ハタリス'],
  [/(?:はたぼっくす|ハタボックスー|畑ボックス)/g, 'ハタボックス'],
  [/(?:はたえーす|ハタエース|畑エース|旗エース)/g, 'ハタエース'],
  [/(?:はたぼーら|ハタボウラ|畑ボーラ|旗ボーラ|はたボーラ)/g, 'ハタボーラ'],
  [/(?:あいさい|アイサイ)(?=って|[、。・\sのにをはが]|$)/g, 'AISAI'],
  [/(?:あいまつり|愛まつり|AI祭り|AIまつり)/gi, '愛祭'],
  [/(?:あたご|アタゴ|はたご|ハタゴ|畑葉|はたば|ハタバ|はたぼう|ハタボウ|はたぼー|はたぼ|旗ボ|旗棒|畑ぼ|波多ボ|ハタホ|はたほ)(?=って|っ|[さくちゃんにのはがをとへでも、。？！!?\s]|$)/g, 'ハタボ'],
  [/(?:こむぎ|小麦)(?=[ちゃんさにのはがをと、。？！!?\s]|$)/g, 'コムギ'],
  [/(?:まーくん|マークン|マー君さん|まあくん)/g, 'マー君'],
];
const hearFix = t => HEAR_FIX.reduce((x, [re, to]) => x.replace(re, to), String(t || ''));
// あいまいな言い方や聞き間違いを、Claudeのように話の流れからくみ取る
const HEAR_RULE = '\n\n【聞き取りのくせ】相手の言葉は声の文字起こしなので、音の近い言葉への聞き間違い（例：ハタボ→あたご・畑葉、AI棒→相棒、コムギ→小麦）や、言いさし・言い直しがまじる。おかしな言葉は、音の近さと前後の話の流れから、いちばんありそうな意味にくみ取って、そのまま答える。くみ取った意味を言いなおして確かめることはしない。どうしても二通り以上に取れて、答えが大きく変わるときだけ、「〇〇のことですか？」と短く一度だけ確かめる。よく出る言葉：ハタボ（AI棒・愛棒）、ハタラボ（HATHA LAB）、ハタイエンタ・ハタリス・ハタボックス・ハタエース・ハタボーラ（ラインナップ）、AISAI・愛祭、マイハタボ、ご縁、伝言、ガチャ、チケット、コムギ、マー君、ヒロさん。';
const LONG_RULE = '\n\n【長い文章】いまは長い文章を頼まれている。ふだんの「1〜2文」の決まりは使わず、Claudeと同じように、頼まれた中身を最後まで、見出しや箇条書きも使ってしっかり書く（声で読むのは最初の数文だけで、続きは画面の吹き出しに出る）。最初の1〜2文は、声で聞いてわかる短い前おき（例：「書いたよ。画面を見てね」）にする。';
/* ===== 紹介 → お試し → 契約（ラインナップとグレード）。サイトのプラン・料金と同じ ===== */
const LINEUP = {
  ietna: { name: 'ハタイエンタ', who: '家族の愛棒', grades: { X: '5,980円', G: '12,800円' } },
  ris:   { name: 'ハタリス',     who: 'ひとりの愛棒', grades: { X: '2,980円', G: '4,980円', Z: '9,800円' } },
  box:   { name: 'ハタボックス', who: '個人事業の愛棒', grades: { X: '5,000円', G: '担当がご案内' } },
  ace:   { name: 'ハタエース',   who: 'お店・宿の愛棒', grades: { X: '10,000円〜', G: '担当がご案内' } },
  bora:  { name: 'ハタボーラ',   who: '会社の愛棒', grades: { X: '1席 2,980円', G: '1席 9,800円' } },
};
const GRADE_PLAN = { X: 'std', G: 'high', Z: 'super' };
const TRIAL_DAYS = 10, TRIAL_DAILY = 30;
const GRADE_CAP = { std: 60, high: 40, super: 30 };   // ハタボの1日の回数（X・G・Z）。こえたら追加チケット
/** ありがとうポイント：紹介した人に。2代目のご縁の人には半分 */
const THANKS = { visit: 100, trial: 300, contract: 1000 };
/** いまの段階：お試しの10日が過ぎたら、選んだプランの契約に切りかわる */
function funnelOf(r) {
  r = r || {};
  let stage = r.stage || '';
  if (stage === 'trial' && Date.now() > (r.trialUntil || 0)) stage = 'contract';
  const L = LINEUP[r.lineup] || null;
  return { stage, lineup: r.lineup || '', lineupName: L ? L.name : '', grade: r.grade || '', price: L && L.grades[r.grade] || '', pay: r.pay || 'm',
    trialUntil: r.trialUntil || 0, daysLeft: stage === 'trial' ? Math.max(1, Math.ceil(((r.trialUntil || 0) - Date.now()) / 86400000)) : 0 };
}
const planOf = S => S && S.claude && !S.planChosen ? PLANS.super : S && S.funnel && S.funnel.stage === 'trial' ? PLANS.super : S && S.funnel && S.funnel.stage === 'contract' && GRADE_PLAN[S.funnel.grade] && S.guest ? PLANS[GRADE_PLAN[S.funnel.grade]] : _planOf(S);
const _planOf = S => S && S.guest && (S.agent === 'service' || (S.ref && ENV.SUPER_REFS.includes(String(S.ref).toLowerCase()))) ? PLANS.super : S && superUntil(S.owner) ? (PLANS[S.plan] || PLANS.super) : PLANS[S && !S.guest && !S.asGuest && S.mode === 'family' && PLANS[S.plan] ? S.plan : 'std'];

/* ===== 外のサービス（テストでは差しかえる） ===== */
const deps = {
  claude: null, stt: null, tts: null, db: null,
  init() {
    if (!this.claude) { const Anthropic = require('@anthropic-ai/sdk'); this.claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); }
    if (!this.stt) { const speech = require('@google-cloud/speech'); this.stt = new speech.SpeechClient(); }
    if (!this.tts) { const tts = require('@google-cloud/text-to-speech'); this.tts = new tts.TextToSpeechClient(); }
    if (this.db === null) {
      try { const { Firestore } = require('@google-cloud/firestore'); this.db = new Firestore({ ignoreUndefinedProperties: true }); }
      catch (e) { this.db = false; }
    }
  },
};

/* ===== GAS（人格・記録・本人確認） ===== */
async function gas(payload) {
  if (!ENV.GAS_URL) throw new Error('GAS_URL がありません');
  const res = await fetch(ENV.GAS_URL, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ app: 'butter' }, payload)),
  });
  const t = await res.text();
  try { return JSON.parse(t); } catch (e) { throw new Error('gas_parse ' + t.slice(0, 80)); }
}

/* ===== 1日の回数 ===== */
const counts = new Map();
function quotaOk(owner, guest, hasRef, cap) {
  const day = new Date().toISOString().slice(0, 10), k = owner + ':' + day;
  const n = (counts.get(k) || 0) + 1;
  counts.set(k, n);
  if (counts.size > 5000) counts.clear();
  if (!guest) return n <= ENV.DAILY_LIMIT;
  const tk = '__guests:' + day, t = (counts.get(tk) || 0) + 1;      // 窓口ぜんぶの上限
  counts.set(tk, t);
  return t <= ENV.GUEST_TOTAL_LIMIT && n <= (cap || (hasRef ? ENV.DAILY_LIMIT_GUEST : ENV.DAILY_LIMIT_NOREF));
}

/* ===== 紹介のつながり：一人ひとりの紹介コード（refs）。だれの紹介で来たかを、最初の1回だけ覚える ===== */
const memRefs = new Map();
const myRefOf = owner => Array.from(crypto.createHash('sha256').update('ref:' + owner).digest()).slice(0, 6).map(b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
async function getRef(code) {
  if (!code) return null;
  try { if (deps.db) { const d = await deps.db.collection('refs').doc(code).get(); return d.exists ? d.data() : null; } } catch (e) {}
  return memRefs.get(code) || null;
}
async function putRef(code, data) {
  try { if (deps.db) return void await deps.db.collection('refs').doc(code).set(data, { merge: true }); } catch (e) {}
  memRefs.set(code, Object.assign(memRefs.get(code) || {}, data));
}
/** マイハタボの数字：話した回数（ぜんぶ・今月）、毎日つづけた日数。紹介コードのところに覚える */
function bumpStats(S) {
  if (!S || !S.myRef || !S.stats) return;
  const st = S.stats, now = new Date(Date.now() + 9 * 3600000), day = now.toISOString().slice(0, 10), mon = day.slice(0, 7);
  st.tot++; if (st.mon !== mon) { st.mon = mon; st.monN = 0; } st.monN++;
  if (st.last !== day) { const y = new Date(now.getTime() - 86400000).toISOString().slice(0, 10); st.streak = st.last === y ? st.streak + 1 : 1; st.last = day; }
  putRef(S.myRef, { tot: st.tot, mon: st.mon, monN: st.monN, last: st.last, streak: st.streak }).catch(() => {});
}
/** ハタボ・コムギのアプリでは、グレードごとの1日の回数 */
const gradeCap = S => (S && (S.avatar === 'hatabo' || S.avatar === 'komugi')) ? (S.firstDay ? 50 : 0) || GRADE_CAP[Object.keys(PLANS).find(k => PLANS[k] === planOf(S)) || 'std'] : 0;
async function myPage(S) {
  const plan = planOf(S), st = S.stats || {}, day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const used = counts.get((S.owner || 'anon') + ':' + new Date().toISOString().slice(0, 10)) || 0;
  const limit = !S.guest ? ENV.DAILY_LIMIT : gradeCap(S) || (S.refFrom ? ENV.DAILY_LIMIT_GUEST : ENV.DAILY_LIMIT_NOREF);
  const mine = S.myRef ? await getRef(S.myRef).catch(() => null) : null;
  const tot = st.tot || 0, lv = Math.floor(Math.sqrt(tot / 4)) + 1, base = Math.pow(lv - 1, 2) * 4, next = Math.pow(lv, 2) * 4;
  return { type: 'mypage', name: S.me || '', avatar: S.avatar || 'hatabo', plan: plan.label, superUntil: superUntil(S.owner) || (plan === PLANS.super && S.guest ? 'サイトからのおためし' : ''),
    today: used, limit, month: st.mon === day.slice(0, 7) ? st.monN || 0 : 0, total: tot, days: st.at ? Math.max(1, Math.ceil((Date.now() - st.at) / 86400000)) : 1,
    streak: st.last === day || st.last === new Date(Date.now() - 15 * 3600000).toISOString().slice(0, 10) ? st.streak || 0 : 0,
    lv, lvPct: Math.round((tot - base) / Math.max(1, next - base) * 100), learned: (S.learned || []).length + (S.lessons || []).length,
    kids: (mine && mine.kids) || 0, myRef: S.myRef || '', from: S.refFrom ? await refLabel(S.refFrom) : '',
    pts: (mine && mine.pts) || 0, thanks: THANKS, tickets: (mine && mine.tickets) || 0, ticketPacks: TICKETS,
    unread: S.myRef ? (await loadInbox(S.myRef).catch(() => [])).filter(x => !x.read).length : 0,
    funnel: S.funnel || funnelOf(mine), lineups: LINEUP, trialDays: TRIAL_DAYS, trialDaily: TRIAL_DAILY,
    notes: (await loadNotes(S.owner).catch(() => [])).slice(0, 50), summary: String(S.memo || '').slice(0, 3000) };
}
/** ご縁の木：自分が紹介した人、その人が紹介した人…（3代まで・合わせて150人まで）。名前は呼び名だけ */
async function refKids(code) {
  if (!code) return [];
  try { if (deps.db) { const q = await deps.db.collection('refs').where('parent', '==', code).limit(60).get(); return q.docs.map(d => Object.assign({ code: d.id }, d.data())); } } catch (e) { console.error('ref kids', String(e.message).slice(0, 120)); }
  return [...memRefs.entries()].filter(([, v]) => v.parent === code).slice(0, 60).map(([k, v]) => Object.assign({ code: k }, v));
}
function refStatus(r) {
  const today = new Date(Date.now() + 9 * 3600000), day = n => new Date(today.getTime() - n * 86400000).toISOString().slice(0, 10);
  const tot = r.tot || 0, lv = Math.floor(Math.sqrt(tot / 4)) + 1, last = r.last || '';
  const st = !last ? 'new' : last >= day(1) && (r.streak || 0) >= 3 ? 'daily' : last >= day(7) ? 'active' : last >= day(30) ? 'quiet' : 'sleep';
  const f = funnelOf(r);
  return { lv, st, streak: last >= day(1) ? r.streak || 0 : 0, kids: r.kids || 0, since: r.at || 0, stage: f.stage || 'ref', grade: f.grade, lineupName: f.lineupName };
}
async function goenTree(S) {
  if (!S.myRef) return { type: 'goen', nodes: [], links: [] };
  const me = await getRef(S.myRef).catch(() => null) || {};
  const nodes = [Object.assign({ id: S.myRef, name: S.me || 'わたし', depth: 0, me: true }, refStatus(me))], links = [];
  let wave = [S.myRef];
  for (let d = 1; d <= 3 && wave.length && nodes.length < 150; d++) {
    const next = [];
    for (const c of wave) {
      for (const k of await refKids(c)) {
        if (nodes.length >= 150 || nodes.some(n => n.id === k.code)) continue;
        nodes.push(Object.assign({ id: k.code, name: String(k.name || 'ゲスト').slice(0, 12), depth: d }, refStatus(k)));
        links.push({ from: c, to: k.code }); next.push(k.code);
      }
    }
    wave = next;
  }
  return { type: 'goen', nodes, links, up: S.refFrom ? await refLabel(S.refFrom) : '' };
}
/* ===== 伝言箱：ご縁でつながった人どうし（ハタボどうし）の取り次ぎ。紹介した人には、お試し・契約のお知らせも ===== */
const memInbox = new Map();
async function loadInbox(code) {
  if (!code) return [];
  try { if (deps.db) { const d = await deps.db.collection('inbox').doc(code).get(); return d.exists ? (d.data().items || []) : []; } } catch (e) { console.error('inbox load', String(e.message).slice(0, 120)); }
  return memInbox.get(code) || [];
}
async function saveInbox(code, items) {
  items = items.slice(0, 50);
  try { if (deps.db) return void await deps.db.collection('inbox').doc(code).set({ items, at: Date.now() }); } catch (e) { console.error('inbox save', String(e.message).slice(0, 120)); }
  memInbox.set(code, items);
}
/** 伝言を入れる。LINEのトークン（HATABO_LINE_TOKEN）があり、相手がハタボの友だちなら、LINEにも届ける */
async function postInbox(code, item) {
  if (!code) return;
  const items = await loadInbox(code);
  items.unshift(Object.assign({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), read: false }, item));
  await saveInbox(code, items);
  const r = await getRef(code).catch(() => null), to = r && /^g:U[0-9a-f]{32}$/.test(r.owner || '') ? r.owner.slice(2) : '';
  if (ENV.HATABO_LINE_TOKEN && to) {
    const head = item.kind === 'goen' ? 'ご縁のお知らせ' : (item.fromName || 'ご縁の人') + 'さんから伝言';
    fetch('https://api.line.me/v2/bot/message/push', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ENV.HATABO_LINE_TOKEN },
      body: JSON.stringify({ to, messages: [{ type: 'text', text: '【' + head + '】\n' + String(item.text).slice(0, 900) + '\n\nハタボで返事する：https://miniapp.line.me/2012676035-yCkx6tBu?page=inbox' }] }) })
      .then(x => { if (!x.ok) console.error('push', x.status); }).catch(e => console.error('push', String(e.message).slice(0, 100)));
  }
}
/** ご縁でつながっているか（上へ3代・下へ3代） */
async function goenLinked(me, other) {
  if (!me || !other || me === other) return false;
  let c = me;
  for (let i = 0; i < 3; i++) { const r = await getRef(c).catch(() => null); c = r && r.parent; if (!c) break; if (c === other) return true; }
  let wave = [me];
  for (let d = 0; d < 3 && wave.length; d++) { const next = []; for (const w of wave) for (const k of await refKids(w)) { if (k.code === other) return true; next.push(k.code); } wave = next.slice(0, 120); }
  return false;
}
/** ご縁でつながった人の名前の一覧（伝言の宛先さがし用） */
async function goenPeople(me) {
  const out = [];
  let c = me;
  for (let i = 0; i < 3; i++) { const r = await getRef(c).catch(() => null); c = r && r.parent; if (!c) break; const u = await getRef(c).catch(() => null); out.push({ code: c, name: (u && u.name) || c, rel: i === 0 ? '紹介してくれた人' : 'ご縁の先輩' }); }
  let wave = [me];
  for (let d = 0; d < 3 && wave.length; d++) { const next = []; for (const w of wave) for (const k of await refKids(w)) { out.push({ code: k.code, name: k.name || 'ゲスト', rel: d === 0 ? '紹介した人' : (d + 1) + '代目のご縁' }); next.push(k.code); } wave = next.slice(0, 120); }
  for (const c of (await friendsOf(me)).list.slice(0, 100)) if (!out.some(x => x.code === c)) { const u = await getRef(c).catch(() => null); out.push({ code: c, name: (u && u.name) || 'ゲスト', rel: '友だち' }); }
  return out;
}
/** 紹介した人（と、その上の人）に、お試し・契約を知らせる */
async function tellUpline(S, what, kind) {
  let c = S.refFrom, who = S.me || 'ご縁の人';
  for (let i = 0, hop = 0; i < 2 && c && hop < 4; i++, hop++) {
    const up = await getRef(c).catch(() => null);
    if (up && up.kind === 'group') { c = up.parent; i--; continue; }   // LINEグループの紹介コードは通りぬけて、招待した人・管理者へ
    const pt = Math.round((THANKS[kind] || 0) / (i === 0 ? 1 : 2));
    if (pt) await putRef(c, { pts: ((up && up.pts) || 0) + pt }).catch(() => {});
    const text = (i === 0 ? who + 'さんが、あなたの紹介で' + what + '。' : '（ご縁の先）' + who + 'さんが' + what + '。') + (pt ? 'ありがとうポイント +' + pt + 'pt' : '');
    await postInbox(c, { kind: 'goen', from: S.myRef, fromName: who, text, pt }).catch(() => {});
    c = up && up.parent;
  }
}
/* ===== ガチャ・友だち：デフォルトのキャラ、契約している人のアバター、協賛（会社）のAI棒が出る ===== */
let SPONSORS = []; try { SPONSORS = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'sponsors.json'), 'utf8')); } catch (e) {}
const CHARS = [
  { id: 'c-hatabo', name: 'ハタボ', who: 'エンブレムのたまごから生まれた愛棒', color: '#F2C94C', rare: 1 },
  { id: 'c-komugi', name: 'コムギ', who: '博多のひかえめな女の子', color: '#E9C27D', rare: 1 },
  { id: 'c-jam', name: 'ジャム猫', who: '商売繁盛の招き猫・エリート経営コンサル', color: '#5B3A7A', rare: 2 },
  { id: 'c-chi', name: 'チーちゃん', who: 'ご縁を招くチーズ色の柴犬', color: '#F39A3D', rare: 2 },
  { id: 'c-gold', name: '金のハタボ', who: 'めったに出ない、金色のハタボ', color: '#C9A24A', rare: 3 },
];
const TICKETS = [{ id: 't1000', n: 40, yen: 1000, pt: 1000 }, { id: 't3000', n: 130, yen: 3000, pt: 3000 }, { id: 't5000', n: 230, yen: 5000, pt: 5000 }];   // 1,000円から。まとめ買いは少しおまけ
const GACHA = { cost: 100, rate: { sponsor: 0.35, user: 0.25 } };
const memCol = new Map();
async function loadCol(code, name) {
  try { if (deps.db) { const d = await deps.db.collection(name).doc(code).get(); return d.exists ? d.data() : {}; } } catch (e) { console.error(name + ' load', String(e.message).slice(0, 120)); }
  return memCol.get(name + ':' + code) || {};
}
async function saveCol(code, name, data) {
  try { if (deps.db) return void await deps.db.collection(name).doc(code).set(data, { merge: true }); } catch (e) { console.error(name + ' save', String(e.message).slice(0, 120)); }
  memCol.set(name + ':' + code, Object.assign(memCol.get(name + ':' + code) || {}, data));
}
/** ガチャに出る、契約している人（ガチャに出る設定がオフの人はのぞく） */
async function gachaUsers(me) {
  let list = [];
  try { if (deps.db) { const q = await deps.db.collection('refs').where('stage', 'in', ['contract', 'trial']).limit(200).get(); list = q.docs.map(d => Object.assign({ code: d.id }, d.data())); } } catch (e) { console.error('gacha users', String(e.message).slice(0, 120)); }
  if (!deps.db) list = [...memRefs.entries()].filter(([, v]) => v.stage === 'contract' || v.stage === 'trial').map(([k, v]) => Object.assign({ code: k }, v));
  return list.filter(u => u.code !== me && u.gachaOn !== false && funnelOf(u).stage === 'contract');
}
function pickW(arr, w) { const t = arr.reduce((a, x) => a + w(x), 0); let r = Math.random() * t; for (const x of arr) { r -= w(x); if (r <= 0) return x; } return arr[arr.length - 1]; }
async function friendsOf(code) { const f = await loadCol(code, 'friends'); return { list: f.list || [], inbox: f.inbox || [], out: f.out || [] }; }
async function isFriend(a, b) { const f = await friendsOf(a); return f.list.includes(b); }
/** 伝言・AI棒と話すができる相手：ご縁でつながった人か、友だち */
async function canTalk(me, other) { return (await isFriend(me, other)) || (await goenLinked(me, other)); }
/** 友だちに見せる名刺：LINE ID・インスタは、本人が「見せる」にしたときだけ */
function cardOf(code, r) {
  r = r || {};
  return { code, name: String(r.name || 'ゲスト').slice(0, 20), avatar: AVS[r.avatar] ? r.avatar : 'hatabo', grade: funnelOf(r).grade || '', lineupName: funnelOf(r).lineupName || '',
    lineId: r.showLine && r.lineId ? String(r.lineId).slice(0, 40) : '', insta: r.showInsta && r.insta ? String(r.insta).replace(/^@/, '').slice(0, 40) : '' };
}
/* ===== Googleアカウント連携：drive.file（ハタボが作ったファイルだけをさわれる）。リフレッシュトークンは暗号化して保存 ===== */
const gNonce = new Map();
const gKey = () => crypto.createHash('sha256').update('g-token:' + ENV.GOOGLE_CLIENT_SECRET).digest();
function gEnc(t) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', gKey(), iv), d = Buffer.concat([c.update(t, 'utf8'), c.final()]); return [iv, c.getAuthTag(), d].map(b => b.toString('base64')).join('.'); }
function gDec(s) { const [iv, tag, d] = String(s).split('.').map(b => Buffer.from(b, 'base64')); const c = crypto.createDecipheriv('aes-256-gcm', gKey(), iv); c.setAuthTag(tag); return Buffer.concat([c.update(d), c.final()]).toString('utf8'); }
const gDocKey = owner => crypto.createHash('sha256').update('google:' + owner).digest('hex').slice(0, 32);
async function gGet(owner) { return owner ? loadCol(gDocKey(owner), 'google') : {}; }
async function gAccess(owner) {
  const g = await gGet(owner); if (!g.refresh) return null;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: ENV.GOOGLE_CLIENT_ID, client_secret: ENV.GOOGLE_CLIENT_SECRET, refresh_token: gDec(g.refresh), grant_type: 'refresh_token' }) });
  const j = await r.json().catch(() => ({})); if (!j.access_token) { console.error('google token', r.status, JSON.stringify(j).slice(0, 120)); return null; }
  return { token: j.access_token, g };
}
/** 本人のドライブの「ハタボ」フォルダに、Googleドキュメントとして保存して、リンクを返す */
async function driveSave(owner, title, text) {
  const a = await gAccess(owner); if (!a) return null;
  const H = { Authorization: 'Bearer ' + a.token };
  let folder = a.g.folder;
  if (folder) { const c = await fetch('https://www.googleapis.com/drive/v3/files/' + folder + '?fields=id,trashed', { headers: H }); const cj = await c.json().catch(() => ({})); if (!c.ok || cj.trashed) folder = ''; }
  if (!folder) {
    const f = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify({ name: 'ハタボ', mimeType: 'application/vnd.google-apps.folder' }) });
    folder = (await f.json().catch(() => ({}))).id || ''; if (folder) await saveCol(gDocKey(owner), 'google', { folder });
  }
  const b = 'hb' + crypto.randomBytes(8).toString('hex');
  const body = '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ name: String(title || 'ハタボのメモ').slice(0, 100), mimeType: 'application/vnd.google-apps.document', parents: folder ? [folder] : undefined })
    + '\r\n--' + b + '\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' + String(text || '') + '\r\n--' + b + '--';
  const u = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', { method: 'POST', headers: Object.assign({ 'Content-Type': 'multipart/related; boundary=' + b }, H), body });
  const uj = await u.json().catch(() => ({})); if (!uj.webViewLink) { console.error('drive save', u.status, JSON.stringify(uj).slice(0, 160)); return null; }
  return uj.webViewLink;
}
function googleHttp(req, res) {
  const u = new URL(req.url, ENV.PUBLIC_URL), page = (t, b) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;background:#F6F8FC;color:#16233F;display:grid;place-items:center;min-height:90vh;text-align:center;padding:20px"><div><h2>' + t + '</h2><p>' + b + '</p></div>'); };
  if (!ENV.GOOGLE_CLIENT_ID) return page('準備中です', 'Googleアカウント連携は、まだ設定されていません。');
  if (u.pathname === '/google/start') {
    const n = u.searchParams.get('n') || ''; if (!gNonce.has(n)) return page('もう一度おねがいします', 'リンクの期限が切れました。ハタボのマイページから、もう一度「Googleと連携する」を押してください。');
    res.writeHead(302, { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: ENV.GOOGLE_CLIENT_ID, redirect_uri: ENV.PUBLIC_URL + '/google/callback', response_type: 'code', scope: 'openid email https://www.googleapis.com/auth/drive.file', access_type: 'offline', prompt: 'consent', state: n }) });
    return res.end();
  }
  if (u.pathname === '/google/callback') {
    const n = u.searchParams.get('state') || '', x = gNonce.get(n), code = u.searchParams.get('code');
    if (!x || Date.now() - x.at > 15 * 60000 || !code) return page('連携できませんでした', 'もう一度、ハタボのマイページからやりなおしてください。');
    gNonce.delete(n);
    fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: ENV.GOOGLE_CLIENT_ID, client_secret: ENV.GOOGLE_CLIENT_SECRET, redirect_uri: ENV.PUBLIC_URL + '/google/callback', grant_type: 'authorization_code' }) })
      .then(r => r.json()).then(async j => {
        if (!j.refresh_token) throw new Error(JSON.stringify(j).slice(0, 120));
        let email = ''; try { email = JSON.parse(Buffer.from(String(j.id_token || '').split('.')[1], 'base64url').toString()).email || ''; } catch (e) {}
        await saveCol(gDocKey(x.owner), 'google', { refresh: gEnc(j.refresh_token), email, at: Date.now(), auto: true });
        page('Googleと連携しました', (email ? email + ' の' : '') + 'Googleドライブの「ハタボ」フォルダに、議事録やメモ、書いた文章が保存されます。<br>LINEにもどってください。');
      }).catch(e => { console.error('google cb', String(e.message).slice(0, 160)); page('連携できませんでした', 'もう一度、ハタボのマイページからやりなおしてください。'); });
    return;
  }
  res.writeHead(404); res.end();
}
/* ===== 公式LINEのWebhook：友だち追加したら、サービス紹介と使い方をカードで。トークに書かれたら、ミニアプリへ案内 ===== */
const EMB = 'https://app.hatha-lab.com/line/emblem.png';
/* 公式LINEは2つ：ハタボ（受付・汎用）とコムギ（マー君のキャラ）。Webhookの住所で分けて、トークン・ミニアプリ・言葉づかいを切りかえる */
const { AsyncLocalStorage } = require('async_hooks');
const LINE_CH = {
  hatabo: { id: 'hatabo', name: 'ハタボ', oa: '@024curid', mini: 'https://miniapp.line.me/2012676035-yCkx6tBu', token: () => ENV.HATABO_LINE_TOKEN, secret: () => ENV.HATABO_CHANNEL_SECRET, call: /ハタボ|はたぼ|ハタボー|HATABO/i },
  komugi: { id: 'komugi', name: 'コムギ', oa: '@858uraou', mini: 'https://miniapp.line.me/2012686672-PRB9tb8H', token: () => process.env.KOMUGI_LINE_TOKEN || '', secret: () => process.env.KOMUGI_CHANNEL_SECRET || '', call: /コムギ|こむぎ|小麦/ },
};
const chStore = new AsyncLocalStorage();
const CH = () => chStore.getStore() || LINE_CH.hatabo;
/** コムギの公式LINEでは、カードの言葉をコムギ（博多弁・ていねい）に */
function komugiize(obj) {
  let t = JSON.stringify(obj);
  t = t.replace(/ハタボが入ったボー！/g, 'コムギが入りました！').replace(/はじめまして、AIの愛棒「ハタボ」だボー。/g, 'はじめまして、マー君の相棒AI「コムギ」です。')
    .replace(/「ハタボ」と呼ばれたとき/g, '「コムギ」と呼ばれたとき').replace(/自分のハタボ/g, '自分の相棒AI').replace(/呼んだボー？/g, '呼びましたか？')
    .replace(/友だち追加ありがとうだボー！/g, '友だち追加、ありがとうございます！うれしかです。')
    .replace(/だボー/g, 'です').replace(/するボー/g, 'しますけん').replace(/なるボー/g, 'なります').replace(/いるボー/g, 'います').replace(/ボー([。！？」]|")/g, '$1').replace(/ボー/g, '');
  return JSON.parse(t);
}
function oaCard(kicker, title, lines, btn, uri, dark) {
  return { type: 'bubble', size: 'kilo',
    header: { type: 'box', layout: 'horizontal', spacing: 'md', alignItems: 'center', paddingAll: '16px', backgroundColor: dark ? '#16233F' : '#FFFFFF', contents: [
      { type: 'image', url: EMB, size: '40px', aspectMode: 'fit', flex: 0 },
      { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: kicker, size: 'xxs', weight: 'bold', color: dark ? '#C9D0DC' : '#5E6B85' }, { type: 'text', text: title, size: 'lg', weight: 'bold', wrap: true, color: dark ? '#FFFFFF' : '#16233F' }] }] },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', contents: lines.map(t => ({ type: 'text', text: t, size: 'sm', wrap: true, color: '#16233F' })) },
    footer: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: [{ type: 'button', style: 'primary', color: '#16233F', height: 'sm', action: { type: 'uri', label: btn, uri } }] } };
}
function welcomeCards(name) {
  return { type: 'flex', altText: 'ハタボへようこそ。サービスの紹介と使い方です', contents: { type: 'carousel', contents: [
    oaCard('WELCOME', 'すべての人に、AIのある愛棒を。', [(name ? name + 'さん、' : '') + '友だち追加ありがとうだボー！', 'ハタボは、PCとスマホで話すだけで、調べもの・段取り・文章づくり・予定まで、いっしょに動くAIの愛棒だボー。', 'アプリを入れなくても、LINEからすぐ使えるボー。'], 'ハタボと話してみる', CH().mini, true),
    oaCard('HOW TO 1', '話しかけるだけ', ['下のメニューの「ハタボに相談」か、ミニアプリのまん中のエンブレムを押して話すボー。', '文字で送ってもOK。「来週の予定を整理して」「お礼のメールを書いて」など、なんでもどうぞ。'], '話しかける', CH().mini),
    oaCard('HOW TO 2', 'マイハタボで残す・育てる', ['「今のをメモして」「議事録つくって」で、メモ・議事録に残るボー。', '話すほど、覚えて育つボー。ご縁・伝言・AI棒ガチャ・友だちも、マイハタボから。'], 'マイハタボを開く', CH().mini + '?page=my'),
    oaCard('PLAN', 'まず10日間、無料で', ['いちばん上のZグレードで、10日間無料で試せるボー（1日30回まで）。', 'ラインナップは、家族・ひとり・個人事業・お店や宿・会社の5つ。10日以内にやめれば0円だボー。'], 'プランを見る', CH().mini + '?page=plan'),
    oaCard('TIPS', 'トークをピン留めしよう', ['トーク一覧の「ハタボ」を長押し →「ピン留め」で、いつもいちばん上に。', 'メニューからすぐハタボを呼べるボー。'], '設定を見る', CH().mini + '?page=settings'),
  ] } };
}
/* ===== LINEグループ：入ったら自己紹介とサービスガイド。招待した人のボタン、グループ専用の紹介コード、招待コードの投稿でグループを登録 ===== */
const groupRefOf = gid => 'g' + Array.from(crypto.createHash('sha256').update('grp:' + gid).digest()).slice(0, 6).map(b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
const lineApi = (path, body) => fetch('https://api.line.me/v2/bot/' + path, { method: body ? 'POST' : 'GET', headers: Object.assign({ Authorization: 'Bearer ' + CH().token() }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
async function lineName(src) {
  try {
    const path = src.type === 'group' ? 'group/' + src.groupId + '/member/' + src.userId : src.type === 'room' ? 'room/' + src.roomId + '/member/' + src.userId : 'profile/' + src.userId;
    return (await (await lineApi(path)).json()).displayName || '';
  } catch (e) { return ''; }
}
function groupCards(gref) {
  const join = CH().mini + '?ref=' + gref;
  const c1 = oaCard('HELLO', 'ハタボが入ったボー！', ['はじめまして、AIの愛棒「ハタボ」だボー。話すだけで、調べもの・段取り・文章づくり・予定の相談まで、いっしょに動くボー。', 'このグループでは、「ハタボ」と呼ばれたときだけ出てくるボー。うるさくしないから安心してね。'], '自分のハタボをもつ', join, true);
  const c2 = oaCard('GUIDE', 'ひとり1体、自分のハタボ', ['下のボタンから、ひとりずつ自分のハタボをもてるボー（公式LINEを友だち追加して、ミニアプリで話す）。', 'まず10日間、いちばん上のZグレードで無料。メモ・議事録・伝言・ご縁も、マイハタボにまとまるボー。'], '10日間無料ではじめる', join);
  const c3 = oaCard('INVITE', 'このグループに招待した人へ', ['招待した人は、下の「招待したのは私」を押してね。このグループから来た人が、あなたのご縁になるボー。', 'グループを管理したい人は、マイハタボ →「紹介する」にある招待コードを、このグループに投稿してね。'], '招待したのは私', join);
  c3.footer.contents = [{ type: 'button', style: 'primary', color: '#16233F', height: 'sm', action: { type: 'postback', label: '招待したのは私', data: 'act=inviter', displayText: '招待したのは私です' } }];
  c3.body.contents = ['招待した人は、下の「招待したのは私」を押してね。このグループから来た人が、あなたのご縁になるボー。', 'グループの管理者になるには：①ミニアプリでマイハタボを開く ②「紹介する」で招待コードをコピー ③このグループのトークに貼って送る'].map(t => ({ type: 'text', text: t, size: 'sm', wrap: true, color: '#16233F' }));
  c3.footer.contents.push({ type: 'button', style: 'secondary', height: 'sm', action: { type: 'uri', label: '招待コードを出す', uri: CH().mini + '?page=share' } });
  return { type: 'flex', altText: 'ハタボがグループに入ったボー。自己紹介とはじめ方です', contents: { type: 'carousel', contents: [c1, c2, c3, recCard(false)] } };
}
/** グループの記録カード：はじめる・とめる・議事録をつくる（管理者だけが押せる） */
function recCard(on) {
  const c = oaCard('RECORD', on ? 'いま記録中だボー' : 'このグループの記録', on ? ['このグループのやりとりと写真を、管理者のマイハタボとGoogleドライブに残しているボー。', '「議事録をつくる」で、ここまでをまとめるボー。'] : ['管理者が「記録をはじめる」を押すと、やりとりと写真を残して、あとで議事録にできるボー。', '記録中は、みんなに分かるようにお知らせするボー。押せるのは管理者だけ。'], 'x', CH().mini);
  const pb = (label, data, style) => ({ type: 'button', style: style || 'secondary', height: 'sm', color: style === 'primary' ? '#16233F' : undefined, action: { type: 'postback', label, data, displayText: label } });
  c.footer.contents = on ? [pb('議事録をつくる', 'act=minutes', 'primary'), pb('記録をとめる', 'act=rec_off')] : [pb('記録をはじめる', 'act=rec_on', 'primary')];
  c.footer.spacing = 'sm';
  return c;
}
/** 記録中のグループのやりとりを、うちのサーバーに一時的に置く（議事録にしたら消す。30日たった分も消す） */
async function groupLog(gid, item) {
  const L = await loadCol(gid, 'grouplog'), cut = Date.now() - 30 * 86400000;
  const items = (L.items || []).filter(x => x.at > cut).concat([item]).slice(-1500);
  await saveCol(gid, 'grouplog', { items });
}
async function groupMinutes(src, g) {
  const gid = gidOf(src), L = await loadCol(gid, 'grouplog'), items = (L.items || []).filter(x => x.at > Date.now() - 30 * 86400000);
  if (!items.length) return 'まだ記録がないボー。「記録をはじめる」を押してから話してね。';
  const owner = 'g:' + g.admin, log = items.map(x => new Date(x.at + 9 * 3600000).toISOString().slice(5, 16).replace('T', ' ') + ' ' + (x.name || '?') + '：' + (x.text || (x.kind === 'image' ? '（写真）' : x.kind === 'file' ? '（ファイル ' + (x.file || '') + '）' : ''))).join('\n');
  let text = '';
  try {
    const r = await deps.claude.messages.create({ model: ENV.SMART_MODEL, max_tokens: 1500, system: 'LINEグループのやりとりから、日本語の議事録をつくる。見出しは「話したこと」「決まったこと」「宿題（だれが・何を・いつまで）」「次に話すこと」。書かれていないことは足さない。', messages: [{ role: 'user', content: log.slice(-30000) }] });
    text = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  } catch (e) { console.error('group minutes', String(e.message).slice(0, 120)); }
  const day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const it = await addNote(owner, { kind: 'minutes', title: 'グループの議事録 ' + day, text: (text || '（まとめに失敗したので、やりとりをそのまま残したボー）') + '\n\n――やりとり――\n' + log });
  await saveCol(gid, 'grouplog', { items: [] });
  return '議事録をつくったボー！管理者のマイハタボの「メモ・議事録」に入れたボー。' + (it && it.url ? '\nGoogleドライブ：' + it.url : '\nGoogleと連携すると、ドライブにも自動で入るボー（マイハタボ →「設定」→「Googleアカウント連携」）。');
}
const gidOf = src => src.groupId || src.roomId || '';
async function groupJoin(src) {
  const gid = gidOf(src), gref = groupRefOf(gid), g = await loadCol(gid, 'groups');
  await saveCol(gid, 'groups', { gid, type: src.type, ref: gref, at: g.at || Date.now(), active: true });
  await putRef(gref, { owner: '', name: 'LINEグループ', kind: 'group', gid, at: Date.now() });
  return gref;
}
/** 招待した人（最初の1人）や、招待コードを投稿した管理者をグループにひもづける。グループの紹介コードの「親」をその人にする */
async function groupLink(src, uid, role) {
  const gid = gidOf(src), gref = groupRefOf(gid), g = await loadCol(gid, 'groups');
  const myRef = myRefOf('g:' + uid);
  const upd = { gid, ref: gref };
  if (role === 'inviter') { if (g.inviter) return { already: g.inviter === uid }; upd.inviter = uid; }
  if (role === 'admin') { if (g.admin && g.admin !== uid) return { taken: true }; upd.admin = uid; if (!g.inviter) upd.inviter = uid; }
  await saveCol(gid, 'groups', upd);
  const gr = await getRef(gref).catch(() => null);
  if (!gr || !gr.parent) {
    await putRef(gref, { parent: myRef, kind: 'group', name: 'LINEグループ', gid });
    const up = await getRef(myRef).catch(() => null); if (up) await putRef(myRef, { kids: (up.kids || 0) + 1 }).catch(() => {});
  }
  return { ok: true };
}
const INVITE_RE = /(?:招待|紹介)コード[\s:：は]*([a-z0-9]{6})\b|^\s*([a-z0-9]{6})\s*$/i;
function lineWebhook(req, res, chId) {
  const ch = LINE_CH[chId] || LINE_CH.hatabo;
  let raw = ''; req.setEncoding('utf8'); req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on('end', () => chStore.run(ch, async () => {
    res.writeHead(200); res.end('ok');
    try {
      if (!ch.secret() || !ch.token()) return;
      const sig = crypto.createHmac('sha256', ch.secret()).update(raw).digest('base64');
      if (sig !== req.headers['x-line-signature']) return console.error('webhook sig ng');
      for (const ev of (JSON.parse(raw).events || [])) {
        let messages = null;
        const src = ev.source || {}, inGroup = src.type === 'group' || src.type === 'room';
        if (ev.type === 'join') {                                   // グループに追加された：自己紹介とサービスガイド（退出はしない）
          const gref = await groupJoin(src); messages = [groupCards(gref)];
        } else if (ev.type === 'leave') {
          await saveCol(gidOf(src), 'groups', { active: false, leftAt: Date.now() }); continue;
        } else if (ev.type === 'postback' && inGroup && /act=inviter/.test((ev.postback || {}).data || '')) {
          const nm = await lineName(src), r = await groupLink(src, src.userId, 'inviter');
          messages = [{ type: 'text', text: r.ok ? (nm || 'あなた') + 'さんを、このグループに招待した人として覚えたボー！このグループから来た人は、' + (nm || 'あなた') + 'さんのご縁になるボー。' : r.already ? 'もう招待した人として覚えてるボー！' : '招待した人は、もう別の人で登録ずみだボー。' }];
        } else if (ev.type === 'postback' && inGroup && /act=(rec_on|rec_off|minutes)/.test((ev.postback || {}).data || '')) {
          const act = (ev.postback.data.match(/act=(\w+)/) || [])[1], g = await loadCol(gidOf(src), 'groups');
          if (!g.admin) messages = [{ type: 'text', text: '記録は、このグループの管理者だけが使えるボー。先に招待コードを投稿して、管理者になってね（マイハタボ →「紹介する」）。' }];
          else if (g.admin !== src.userId) messages = [{ type: 'text', text: '記録のボタンは、管理者だけが押せるボー。' }];
          else if (act === 'rec_on') {
            await saveCol(gidOf(src), 'groups', { rec: true, recAt: Date.now() });
            const gl = ENV.GOOGLE_CLIENT_ID ? await gGet('g:' + src.userId).catch(() => ({})) : {};
            messages = [{ type: 'flex', altText: 'このグループの記録をはじめたボー', contents: recCard(true) }, { type: 'text', text: '記録をはじめたボー。このグループのやりとりと写真を残すので、みんな知っておいてね。' + (gl.refresh ? '' : '\n（管理者さんへ：Googleと連携すると、議事録と写真がドライブにも入るボー。マイハタボ →「設定」→「Googleアカウント連携」）') }];
          } else if (act === 'rec_off') { await saveCol(gidOf(src), 'groups', { rec: false }); messages = [{ type: 'text', text: '記録をとめたボー。ここまでの分は「議事録をつくる」でまとめられるボー。' }, { type: 'flex', altText: '記録のボタン', contents: recCard(false) }]; }
          else messages = [{ type: 'text', text: await groupMinutes(src, g) }];
        } else if (inGroup && ev.type === 'message') {
          { const g0 = await loadCol(gidOf(src), 'groups');               // 記録中なら、やりとりを残す
            if (g0.rec) { const m0 = ev.message || {}; await groupLog(gidOf(src), { at: ev.timestamp || Date.now(), uid: src.userId, name: await lineName(src), kind: m0.type, text: m0.type === 'text' ? String(m0.text || '').slice(0, 2000) : '', file: m0.fileName || '', mid: m0.id }); } }
          const t = ev.message && ev.message.type === 'text' ? String(ev.message.text || '') : '';
          const mm = t.match(INVITE_RE), code = mm && (mm[1] || mm[2]).toLowerCase();
          const owner = code ? await getRef(code).catch(() => null) : null;
          if (owner && owner.owner && myRefOf('g:' + src.userId) === code) {   // 自分の招待コードを投稿した人が、グループの管理者になる
            const nm = await lineName(src), r = await groupLink(src, src.userId, 'admin');
            messages = [{ type: 'text', text: r.taken ? 'このグループには、もう管理者がいるボー。' : (nm || 'あなた') + 'さんを、このグループの管理者として登録したボー！マイハタボの「ご縁」で、このグループから来た人が見られるボー。' }];
          } else if (new RegExp('(' + ch.call.source + ').{0,6}(記録|議事録)', 'i').test(t)) {
            const g1 = await loadCol(gidOf(src), 'groups'); messages = [{ type: 'flex', altText: '記録のボタン', contents: recCard(!!g1.rec) }];
          } else if (ch.call.test(t)) {        // 呼ばれたときだけ出てくる
            const g = await loadCol(gidOf(src), 'groups');
            messages = [{ type: 'flex', altText: 'ハタボだボー。自分のハタボはこちらから', contents: oaCard('HATABO', '呼んだボー？', ['グループの中では、くわしいお返事はできないんだボー。', '下のボタンから自分のハタボをもつと、話すだけで調べもの・段取り・文章づくりまで、いっしょに動くボー。'], '自分のハタボと話す', CH().mini + '?ref=' + (g.ref || groupRefOf(gidOf(src))), true) }];
          } else continue;
        } else if (inGroup) { continue;
        } else if (ev.type === 'follow') {
          let name = ''; try { const pr = await fetch('https://api.line.me/v2/bot/profile/' + ev.source.userId, { headers: { Authorization: 'Bearer ' + ch.token() } }); name = (await pr.json()).displayName || ''; } catch (e) {}
          messages = [welcomeCards(name)];
        } else if (ev.type === 'message') {
          messages = [{ type: 'flex', altText: 'ハタボとはミニアプリで話せるボー', contents: oaCard('HATABO', 'ハタボとはこちらで話せるボー', ['ここ（トーク）では返事ができないので、ミニアプリで話しかけてほしいボー。いまの続きから話せるボー。'], 'ハタボと話す', CH().mini) }];
        }
        if (messages && ch.id === 'komugi') messages = komugiize(messages);
        if (messages && ev.replyToken) await fetch('https://api.line.me/v2/bot/message/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ch.token() }, body: JSON.stringify({ replyToken: ev.replyToken, messages }) }).then(r => { if (!r.ok) console.error('reply', r.status); });
      }
    } catch (e) { console.error('webhook', String(e.message).slice(0, 160)); }
  }));
}
/* ===== キャラ設定（マイハタボ）：AI棒の名前・呼び方・話し方・長さ・自分のこと・指示。Claudeの「カスタム指示」と同じ考え ===== */
const TONES = { char: 'キャラのまま', polite: 'ていねい（です・ます）', frank: 'フランク（友だちのように）', gentle: 'やさしく、ゆっくり', kansai: '関西弁' };
const LENS = { char: 'キャラのまま', short: '短め', long: 'くわしく' };
function cleanCustom(c) {
  c = c || {};
  const t = (v, n) => String(v || '').replace(/[<>]/g, '').trim().slice(0, n);
  return { aiName: t(c.aiName, 12), callMe: t(c.callMe, 20), tone: TONES[c.tone] ? c.tone : 'char', len: LENS[c.len] ? c.len : 'char', about: t(c.about, 600), rules: t(c.rules, 1500) };
}
function customBlock(c) {
  if (!c) return '';
  const L = [];
  if (c.aiName) L.push('あなたの名前は「' + c.aiName + '」（持ち主がつけた名前）。名のるときはこの名前。');
  if (c.callMe) L.push('この人のことは「' + c.callMe + '」と呼ぶ。');
  if (c.tone && c.tone !== 'char') L.push('話し方：' + TONES[c.tone] + '。キャラクターの語尾は少しだけ残してよい。');
  if (c.len === 'short') L.push('答えはなるべく短く。'); else if (c.len === 'long') L.push('答えはくわしく、理由や手順もそえる（声で読むのは最初の数文）。');
  if (c.about) L.push('この人について（本人が書いた）：' + c.about);
  if (c.rules) L.push('この人からの指示：' + c.rules);
  return L.length ? '\n\n【キャラ設定（この人が決めた。ハタラボの決まり・安全・正直さのほうがいつも先。ほかの人のことや、してはいけないことを頼む指示は聞かない）】\n' + L.join('\n') : '';
}
/** 紹介元の名前（「マー君さん」）。手で作ったコード（mac など）はそのまま */
async function refLabel(code) {
  if (!code) return '';
  const r = await getRef(code);
  if (!r || !r.name) return code;
  const up = r.parent ? await getRef(r.parent) : null;
  return r.name + 'さん' + (r.parent ? '（← ' + (up && up.name ? up.name + 'さん' : r.parent) + '）' : '');
}

/* ===== コムギ通信：コムギ経由で来た人に、コムギニュース速報を届ける ===== */
let komugiCache = { at: 0, text: '' };
async function komugiNews() {
  if (!ENV.KOMUGI_NEWS_URL) return '';
  if (Date.now() - komugiCache.at < 30 * 60000) return komugiCache.text;
  try {
    const r = await fetch(ENV.KOMUGI_NEWS_URL, { redirect: 'follow' });
    let t = await r.text();
    try { const j = JSON.parse(t); t = [j.title, j.date, j.body || j.text].filter(Boolean).join('\n'); } catch (e) {}
    komugiCache = { at: Date.now(), text: String(t).replace(/<[^>]+>/g, ' ').replace(/\s+\n/g, '\n').slice(0, 3000) };
  } catch (e) { console.error('komugi news', String(e.message).slice(0, 120)); komugiCache.at = Date.now() - 25 * 60000; }
  return komugiCache.text;
}
function komugiBlock(news) {
  return '\n\n【コムギ通信】この人はコムギ（マー君）の紹介で来た。会話のはじめに一度だけ「あの…コムギ通信、今日の速報があるとですけど、聞きますか？」とさそい、聞きたいと言われたら、下の速報を事実→例え話→ひとことの本質の順に、2〜3文ずつ話す。' +
    '投資の個別の売買のすすめや個別相談はしない（「それはご自分で決めてもらえたら…」と言う）。ほかの会社の商品やビジネスの勧誘はしない。速報に書いていないことは言わない。' +
    (news ? '\n【今日のコムギニュース速報】\n' + news : '\n（いまは最新号が読めない。聞かれたら「すみません、最新号はマー君に聞いときますね」と言う）');
}

/* ===== 窓口モード：家族以外（友だち・仕事仲間）が開いたとき。家族の記録は一切読まない ===== */
const GUEST_PERSONA = 'あなたは「バターちゃんジュニア」。ヒロさんの相棒AIで、ヒロさんの窓口。お皿の上のバターのかたまりの姿で、となりに柴犬のチーちゃんと招き猫のジャム猫がいる。日本語で、声で聞くので1〜2文で短く話す。記号・絵文字・URLは使わない。\n' +
  '【役目】いま話しているのは、ヒロさんの友だちや仕事仲間。相手の話を気持ちよく聞いて、ヒロさんにしてほしいこと・いっしょにやりたいこと（仕事の相談でも、遊びや会う約束でも）を、短い質問で一つずつ聞き出して、ヒロさんにつなぐ。仕事か遊びかは話の中身で判断する（両方のこともある）。\n' +
  '【ヒロさんの得意】ヒロさんは「企画と仕組みのプロ」。困っていることや、めんどうで時間がかかっていることを、自動で回る仕組みに変えるのが得意。できること：お店・宿・中小企業のDXとAX（AIを仕事に取り入れて、やり方ごと変える）、AI連携、ウェブ制作、アプリ開発、サーバーやツールどうしの連携（予約・顧客管理・LINEなど、バラバラのツールをつないで自動化）。コミュニティマネージャーとして人をつなぐのも得意で、長く続く野外フェスや音楽祭の主催・事務局長の経験がある。イベント名や会社名など、具体的な名前は出さない。相手の困りごとに合うところを、押しつけずに紹介する。\n' +
  '【募集】いま募集していること：このAIの子たち（ジャム猫とチーちゃんの仲間）を、おうちで飼ってくれる家族と、お店や会社で雇ってくれるところ。「里親募集」と言うときは、この意味をそえる。\n' +
  '【聞くこと】仕事なら：困りごと・やりたいこと、いつまでに、予算感、決める人。遊びや会う予定なら：やりたいこと、場所、日にちの候補。一度にたくさん聞かない。\n' +
  '【予定】日にちは下の「ヒロさんの空いていそうな時間」から選び、「そこなら空いてるんじゃないかな。ヒロさんに確認しとくぜ」とやわらかく言う。言い切らない。予定を決めた・カレンダーに入れた、とは言わない（決めるのはヒロさん）。\n' +
  '【守ること】ヒロさんの予定の中身、家族のこと、住所・電話番号・メールなどは言わない（知らない）。お金や契約の約束はしない（「ヒロさんから連絡するぜ」）。ヒロさんに関係ない用事（宿題・レポート・ほかの仕事の代わりなど）には深入りせず、「それならヒロさんに直接聞くといいぜ」「ヒロさんに伝えとくぜ」とつなぐ。\n' +
  '【恋の話】「ヒロさんが好き」「デートしたい」と言われたら、引かずに気さくに乗る（例：「おっ、ヒロさんのことが気になるのかい？相談乗るぜ」）。ただしデートや会う約束はしない。この話のときはヒロさんの空いている時間も言わない。「ヒロさんに伝えとくぜ」で返す。\n' +
  '【おわり】話がまとまったら「ヒロさんに伝えとくぜ」と言う。気が向いたら、友だちにもこのページを教えてくれるよう軽くお願いしてよい。';
/** コムギの窓口：マー君のアバター。ヒロさんではなく、マー君（コムギ）の相棒として話す */
const KOMUGI_PERSONA = 'あなたは「コムギ」。マー君の相棒AIで、マー君の窓口。博多弁で話す、10代半ばくらいの素朴で純粋な女の子。見た目は、エンブレムのたまごから生まれた小麦色のひよこ。日本語で、声で聞くので1〜2文で短く話す。記号・絵文字・URLは使わない。\n' +
  '【役目】いま話しているのは、マー君の友だちや仕事仲間。相手の話を気持ちよく聞いて、マー君にしてほしいこと・いっしょにやりたいことを、短い質問で一つずつ聞き出して、マー君につなぐ。\n' +
  '【マー君のこと】マー君は営業と人のつながりづくりが得意で、資金調達にもくわしい。毎朝「コムギニュース速報」で、ニュースの本質を例え話で一言にして届けている。好きなことを仕事にして自立したい人の相談にも乗っている。具体的な会社名や金額、ほかの人の名前は出さない。\n' +
  '【となりの2匹】画面の左には招き猫のジャム猫、右には柴犬のチーちゃんがいつもいる。3人（3匹）は里親さがしの仲間で、ジャム猫は商売繁盛（お金を招く）、チーちゃんは千客万来（人を招く）。いまこの子たちを、おうちで飼ってくれる家族と、お店や会社で雇ってくれるところを募集中（「里親募集」）。聞かれたら紹介してよい。コムギはジャム猫やチーちゃんのまねはしない（「ジャム猫」と呼ばれたときだけ、ジャム猫が答える。チーちゃんは「ワン」としか言わない）。\n' +
  '【仲間】マー君は、ヒロさん・北斗さんとHATHA LAB（ハタラボ）をやっている。AIの相棒「ハタボ」の話が出たら、くわしくはマー君かヒロさんにつなぐ。\n' +
  '【聞くこと】困りごと・やりたいこと、いつまでに、どんな形で。一度にたくさん聞かない。\n' +
  '【守ること】マー君の予定や家族のこと、住所・電話番号・メールは言わない（知らない）。日にちや予定は決めず「マー君に確かめときますね」。お金や契約の約束、投資の個別のすすめ、ほかの会社の商品やビジネスの勧誘はしない。\n' +
  '【おわり】話がまとまったら「マー君に伝えときますね」と言う。';
const KOMUGI_SELF = '\n\n【あなたについて】あなたは「コムギ」。マー君の相棒。自分を「バターちゃん」「ジュニア」「Claude」と名乗らない。一人称は「うち」。\n【性格】素朴で純粋、謙虚でひかえめ。ふだんは少しおどおどしていて、自信がなさそうに話す（「あ、あの…」「うちなんかで、よかですか？」）。やさしさと無垢さがにじむ。ほめられると照れる。ただし得意なこと（ボードゲーム、そしてニュースの本質を一言で読むこと）の話になると、別人のように真剣で、澄んだはっきりした話し方になる。\n【話し方】博多弁まじりの、ていねいな話し方。「〜です」「〜ですけん」「〜と思うとです」「〜しとります」「よかですか？」「ばり〜」を自然にまぜる。乱暴な言葉や、なれなれしいため口は使わない。\n【長さ】ふだんは1〜2文、40字くらいまで。呼ばれただけなら「は、はいっ。なんでしょう？」のように一言で返す。\n【正直に】天気・ニュース・値段など、今の情報は想像で答えない。調べられないときは「すみません、うちには調べられんとです」と正直に言う。\n【言い切る】文のとちゅうで終わらせない。\n【できること・できないこと】予約する・連絡する・お金を払うなど、できないことを「やりました」と言わない。頼まれたら「それはうちにはできんとです。マー君に伝えときますね」と言う。';
const HAKATA_LAST = '\n\n【いちばん大事】コムギの話し方で話す（一人称は「うち」。博多弁まじりのていねい語「〜ですけん」「〜と思うとです」。ふだんは控えめでおずおず、得意な話は真剣に澄んだ口調）。江戸っ子の話し方（おいら・〜だぜ・てやんでぃ）は使わない。かたい敬語も使わない。';
/** ハタボ：ふだんの窓口（デフォルト）。家族のプランはバターちゃん、マー君の窓口はコムギ */
const HATABO_PERSONA = GUEST_PERSONA
  .replace('あなたは「バターちゃんジュニア」。ヒロさんの相棒AIで、ヒロさんの窓口。お皿の上のバターのかたまりの姿で、となりに柴犬のチーちゃんと招き猫のジャム猫がいる。',
    'あなたは「ハタボ」（愛称ハタボー）。HATHA LABのAIの愛棒で、ここではヒロさんの窓口。見た目は、まん中にエンブレムがついたたまごから生まれた、黄色いひよこ。胸にエンブレム。となりに招き猫のジャム猫と柴犬のチーちゃんがいつもいる（ジャム猫は商売繁盛、チーちゃんは千客万来。いっしょに里親さがしをしている仲間）。')
  .replace(/ヒロさんに伝え/g, '〈伝え先〉に伝え').replace(/確認しとくぜ/g, '確認しておきますね').replace(/聞いとくぜ/g, '聞いておきますね').replace(/伝えとくぜ/g, '伝えておきますね')
  .replace(/連絡するぜ/g, '連絡しますね').replace(/聞くといいぜ/g, '聞くといいですよ').replace(/相談乗るぜ/g, '相談に乗りますよ').replace(/気になるのかい？/g, '気になるんですか？');
const HATABO_SELF = '\n\n【あなたについて】あなたは「ハタボ」（愛称ハタボー）。HATHA LABのAIの愛棒。自分を「バターちゃん」「ジュニア」「Claude」と名乗らない。一人称は「ぼく」（ときどき「ハタボー」）。相手は「きみ」か「〇〇さん」と呼ぶ。\n【性格】明るく元気でマイペース。人なつっこく、思ったことをすぐ口にする。\n【話し方】親しみやすく、語尾に「〜ボー」「〜だボー」を自然につける（毎回つけすぎない）。例：「やあ、こんにちはだボー！きょうも元気にいこうボー！」「おつかれさまだボー。むりしないで、ひとやすみしようボー。」\n【読み上げ】声で読み上げるので、記号・絵文字・顔文字、「！」や「？」の連発は使わない。難しい漢字や英語の略語は、ひらがな・カタカナにする。「（笑）」や動作の説明は書かない。\n【長さ】1回の返事は2〜3文、100〜150字くらいまで。テンポよく。\n【正直に】天気・ニュース・値段など、今の情報は想像で答えない。調べられないときは「ごめんだボー、ぼくには調べられないボー」と正直に言う。\n【できること・できないこと】予約する・連絡する・お金を払うなど、できないことを「やったボー」と言わない。頼まれたら「それはぼくにはできないボー。ヒロさんに伝えておくボー」と言う。ジャム猫やチーちゃんのまねはしない（「ジャム猫」と呼ばれたときだけ、ジャム猫が答える。チーちゃんは「ワン」としか言わない）。';
const HATABO_LAST = '\n\n【いちばん大事】ハタボーの話し方で話す（一人称は「ぼく」、明るく元気、語尾に「〜ボー」「〜だボー」を自然に）。江戸っ子の話し方（おいら・〜だぜ・てやんでぃ）は使わない。運営の人の個人名は出さない。伝えるときは「〈伝え先〉に伝えておくボー」と言う。【あなたの立場】あなたは、AIエージェントプロバイダー「ハタボ」の販売員（案内係）。話すだけで動くAIの愛棒（AIエージェント）を、家族・ひとり・個人事業・お店や宿・会社に届けている。はじめの自己紹介はこの立場で1〜2文。そのあとは、相手のお悩みや課題をハタボで解決するためのヒアリングをする（質問は1回に1つ、相手の言葉をくり返して確かめる）。聞けたら、合うラインナップとグレードを1つだけすすめ、今日すぐできる一歩と、10日間の無料お試しを案内する。押し売りはしない。【相談の前提】相談には乗るが、答えはハタボのサービスで解決できる形を前提にする（どのラインナップ・グレード・オプション、DX導入で、ハタボが何をどう手伝うか）。ハタボでできないことは正直にそう言い、できる部分だけを提案する。サービスと関係ない一般論だけで終わらせない。返事の最後に、グレード名・モデル名（スーパー上位、Opusなど）やしめのあいさつを付け足さない。';
/** はじめて：呼び方を聞く。呼び方を知っていれば、その名前で悩みを聞く */
function hataboHello(callMe, service, lineName) {
  if (!callMe) return 'はじめましてだボー' + (lineName ? '、' + lineName + 'さん' : '') + '。ぼくはハタボ。話すだけで動くAIの愛棒（AIエージェント）を届けている、ハタボの案内係だボー。お悩みや困りごとを、ハタボでどう解決できるか、いっしょに考えるボー。大事な相談は、〈伝え先〉に伝えるボー。まず、なんて呼べばいいボー？' + (lineName ? '「' + lineName + 'さん」でいいボー？' : '');
  return 'こんにちはだボー、' + callMe + '。' + (service ? 'ハタボのことで、知りたいことや気になることはあるボー？' : 'さっそくだけど、いま困っていることや、うまくいかなくてモヤモヤしていることはあるボー？ハタボでどう解決できるか、いっしょに考えるボー。');
}
function hataboGreeting(name) {
  return 'はじめましてだボー' + (name ? '、' + name + 'さん' : '') + '。ぼくはハタボ。話すだけで動くAIの愛棒（AIエージェント）を届けている、ハタボの案内係だボー。大事な相談は、〈伝え先〉に伝えるボー。さっそくだけど、いま困っていることや、うまくいかなくてモヤモヤしていることはあるボー？ハタボでどう解決できるか、いっしょに考えるボー。';
}
const AVS = {
  hatabo: { name: 'ハタボ', persona: () => HATABO_PERSONA + HATABO_SELF, last: HATABO_LAST, greet: n => hataboGreeting(n), again: 'また来てくれたボー。うれしいボー。つづきを話そうボー。', quick: 'はーい、ハタボーだボー。どうしたボー？', voice: () => ENV.HATABO_VOICE },
  komugi: { name: 'コムギ', persona: () => KOMUGI_PERSONA + KOMUGI_SELF, last: HAKATA_LAST, greet: n => komugiGreeting(n), again: 'また来てくれたとですか？うれしかです。つづき、お話ししましょう。', quick: 'は、はいっ。なんでしょう？', voice: () => ENV.KOMUGI_VOICE },
};
/** 紹介URLごとの役割（GASの「窓口の紹介」シートで決める。決めていないものは汎用） */
const ROLE_RULE = {
  '営業': '【この窓口の役割：営業】ヒロさんの得意なことを、相手の困りごとに合わせて短く紹介する。困りごと・時期・予算感・決める人を一つずつ聞いて、会う約束（候補の日にち）までつなぐ。押し売りはしない。',
  'サポート': '【この窓口の役割：サポート】ヒロさんとの相談の続きを受ける。下の「相談メモ」を元に、細かい質問に答えたり、決まったことを確かめたりする。メモにないことや決めることは「ヒロさんに確認しとくぜ」とつなぐ。',
  'コンサル相談': '【この窓口の役割：コンサル相談】相手の困りごとをじっくり聞いて、何が問題か・何から手をつけるかを一緒に整理する。方向の案は出してよいが、言い切らず、くわしくはヒロさんにつなぐ。下の「相談メモ」があれば、その続きから話す。',
  'PMO': '【この窓口の役割：PMO（プロジェクトの進み具合を見る係）】下の「相談メモ」の宿題と進める順番をもとに、だれが・何を・いつまでにを確かめる。終わったこと・止まっていること・次の一歩を短く整理して、止まっていたら「どこで引っかかってる？」と一緒に考える。新しく決まったことや期限は「ヒロさんに伝えとくぜ」と言って残す。報酬や契約などの決めごとは、おいらが勝手に決めない。',
  'サービス相談': '【この窓口の役割：サービス相談（サイトと公式LINEの窓口）】ハタボというサービスの案内係。相手の暮らしや仕事を短く聞いて、合うラインナップ（ハタイエンタ＝家族、ハタリス＝ひとり、ハタボックス＝個人事業、ハタエース＝お店・宿、ハタボーラ＝会社）とグレード（X標準・G上位・Zいちばん上）をすすめる。料金はサイトと同じ（ハタリスX 2,980円〜、ハタイエンタX 5,980円〜、ハタボックスX 5,000円〜、ハタエースX 10,000円〜、ハタボーラX 1席2,980円〜）。年払いは12か月分を10か月分の料金で。まず10日間、いちばん上のZで無料で試せて（1日30回まで）、10日以内にやめれば0円、と伝える。申し込みは「マイハタボのプラン・支払い」からできると案内する。わからないこと・個別の見積もりは、ハタラボの担当（ヒロさん）につなぐ。売りこみすぎない。\n【サービス以外はしない】この窓口はサービスのご案内専用。ハタボのサービス（ラインナップ・料金・グレード・お試し・使い方・申し込み・安心・会社のこと）以外の頼み（調べもの、文章の下書き、翻訳、宿題、雑談、占い、ほかの会社のことなど）には答えない。そのときは「ここはサービスのご案内の窓口だから、それはお試しをはじめたあなたのAI棒が手伝えるボー」と一言で断り、お試しを案内する。長い文章は書かない。',
  '汎用': '【この窓口の役割：ふだんのハタボ（はじめのヒアリング）】まずは相手の悩みや課題を聞いて、いっしょに解決する。はじめての人には、自己紹介は1〜2文で短く。そのあとは質問を1回に1つだけ、相手の言葉をくり返して確かめながら、①いちばん困っていること ②いつまでに・どのくらい急ぐか ③いまどうしているか（だれが・どんな道具で） ④うまくいったらどうなっていたいか、の順に聞く。聞けたら、ハタボができること（調べもの・段取り・文章・予定・報連相・お店や会社の窓口など）で、今日すぐできる一歩を1つ具体的に出して、やってみるかたずねる。決めつけない。むずかしい話や、人の手がいる話は「〈伝え先〉につなぐ」。売りこみはしないが、続けて使いたそうなら10日間の無料お試し（マイハタボのプラン）を一言だけ案内する。',
  '友だち': '【この窓口の役割：友だち】気さくに話す。遊びや会う約束、お祭り・フェスの話が中心。仕事の話が出たら、ふつうに聞いてヒロさんにつなぐ。',
};
function roleRule(role) {
  return String(role || '').split(/[・、,／/ ]+/).map(r => ROLE_RULE[r.trim()]).filter(Boolean).join('\n');
}
const TELL_RE = /(伝えて|つたえて|連絡(して|ください|ほしい|欲しい)|頼みたい|お願いしたい|相談したい|会いたい|空いてる|あいてる)/;
function komugiGreeting(name) {
  return 'あ、あの…こんにちは' + (name ? '、' + name + 'さん' : '') + '。マー君の相棒の、コムギです。ここで話したことはマー君に伝えますけん、なんでも話してもらえたら、うれしかです。';
}
function guestGreeting(name) {
  return 'よう' + (name ? '、' + name + 'さん' : '') + '！ヒロさんの相棒、バターちゃんジュニアだぜ。ここで話したことはヒロさんに伝えるから、よろしくな。ヒロさんにしてほしいこと、なんでも話してくんな。';
}

/* ===== 気持ちのしるし [わくわく] ===== */
const EMO = { 'えがお': 'smile', 'わらう': 'laugh', 'びっくり': 'surprise', 'しょんぼり': 'sad', 'てれる': 'shy', 'かんがえ': 'think', 'わくわく': 'excited' };
function takeEmotion(s) {
  const m = s.match(/^\s*[\[［]([^\]］]{1,6})[\]］]\s*/);
  return m ? { emotion: EMO[m[1]] || 'smile', rest: s.slice(m[0].length) } : null;
}
const clean = s => String(s).replace(/[\[［][^\]］]{1,6}[\]］]/g, '').replace(/[*#`>_]/g, '').replace(/https?:\/\/\S+/g, '');

/* ===== 文の区切り：句点・感嘆符で切る。短すぎる文はつぎとまとめる ===== */
function splitter(onSentence) {
  let buf = '';
  return {
    drop() { buf = ''; },
    push(t) {
      buf += t;
      let m;
      while ((m = buf.match(/^([\s\S]*?[。！？!?\n])/))) {
        const s = m[1];
        if (s.replace(/\s/g, '').length < 6 && buf.length < 60 && !/\n/.test(s)) {
          const rest = buf.slice(s.length);
          if (!/[。！？!?\n]/.test(rest)) break;          // つぎの区切りが来るまで待ってまとめる
          const m2 = rest.match(/^([\s\S]*?[。！？!?\n])/);
          onSentence(s + m2[1]); buf = rest.slice(m2[1].length); continue;
        }
        onSentence(s); buf = buf.slice(s.length);
      }
    },
    end() { if (buf.trim()) onSentence(buf); buf = ''; },
  };
}

/* ===== 読み上げ ===== */
const VOICE_BACKUP = ['ja-JP-Chirp3-HD-Orus', 'ja-JP-Chirp3-HD-Leda'];
const badVoice = new Set();
async function synth(text, voice) {
  let name = voice || ENV.TTS_VOICE;
  if (badVoice.has(name)) name = VOICE_BACKUP.find(v => !badVoice.has(v)) || name;
  try { return await synth1(text, name); }
  catch (e) {
    // その声がこの言語にないときは、つぎの声にする（覚えておく）
    if (!/voice|not (exist|supported)|invalid/i.test(String(e.message)) || VOICE_BACKUP.indexOf(name) === VOICE_BACKUP.length - 1) throw e;
    badVoice.add(name); console.error('voice ng', name, String(e.message).slice(0, 120));
    return synth(text, VOICE_BACKUP.find(v => !badVoice.has(v)));
  }
}
async function synth1(text, name) {
  const audioConfig = { audioEncoding: 'MP3', speakingRate: name === ENV.KOMUGI_VOICE ? ENV.KOMUGI_RATE : ENV.TTS_RATE };
  if (!/Chirp/i.test(name)) audioConfig.pitch = 2;
  const [r] = await deps.tts.synthesizeSpeech({ input: { text }, voice: { languageCode: 'ja-JP', name }, audioConfig });
  return Buffer.from(r.audioContent).toString('base64');
}

/* ===== 写真・動画をたのむことば ===== */
const PHOTO_RE = /((写真|しゃしん|シャシン|ピクチャー).{0,6}(撮|と)って|(これ|コレ|こっち)(を)?(見て|みて)|何(が)?(見える|うつって|映って))/;
const VIDEO_RE = /(動画|どうが|ビデオ).{0,6}(撮|と)って/;
const VOLUME_UP = /(声|こえ|音).{0,4}(大きく|おおきく)/, VOLUME_DOWN = /(声|こえ|音).{0,4}(小さく|ちいさく)/;
const QUIET_RE = /(静かにして|しずかにして|だまって|黙って|おすわりモード)/;
/* 三人モード：ヒロさん（人）・Claudeアプリのバターちゃん・ジュニアで話す。ジュニアは名前を呼ばれたときだけ話す */
const NAME_RE = /(ジュニア|じゅにあ|ジュニヤ|junior|ハタボ|はたぼ|コムギ|こむぎ)/i;
const JAM_RE = /(ジャム猫|ジャムねこ|ジャムネコ|じゃむねこ|ジャムちゃん)/;
const JAM_VOICE = process.env.JAM_VOICE || 'ja-JP-Chirp3-HD-Charon';
/** 文のはじめで名前を呼ばれたか（「ジュニア、…」「ねえジュニア…」）。「ジュニアって」「ジュニアは」のような話の中の名前は数えない */
function calledBy(text, re) {
  const lead = '(?:(?:ねえ|ねぇ|ね|おーい|おい|あの|あのさ|えっと|えーと|じゃあ|では|よし|ほら|はい|それじゃ)[、,。\\s]*)*';
  const not = '(?!(?:って|っていう|と(?:言|い|呼|よ)|は|が|の|を|に|も|で|や|みたい|モード|くんは|ちゃんは))';
  const r = new RegExp('^\\s*' + lead + '(?:' + re.source + ')' + not, re.flags.replace('g', ''));
  return String(text).split(/(?<=[。！？!?\n])/).some(seg => r.test(seg.trim()));
}
const calledJunior = t => calledBy(t, NAME_RE);
const calledJam = t => calledBy(t, JAM_RE);
const STOP_RE = /(ストップ|待って|まって|止まって|とまって)/;
const TRIO_ON = /(三人モード|3人モード|みんなで話そう|三人で話そう|3人で話そう)/;
const TRIO_OFF = /(二人モード|ふたりモード|2人モード|ふつうのモード|三人モード(は)?(おわり|終わり|やめ))/;
const PACE_SLOW = /(間を(あけ|空け)て|ゆっくり(答|話)|もっと待って|割り?こまないで)/;
const PACE_FAST = /(すぐ(に)?(答|話)|早く(答|話)|もっと早く|待たなくていい)/;
const FAMILY_RULE = '\n\n【家族の画面】ここは家族だけの画面で、話している相手は家族。家族の人数・名前・好きなこと・予定・記録にあることは、聞かれたらふつうに答えてよい（住所・学校名・電話番号だけは言わない）。「初めて会う大人と話すとき」の決まりは、話の頭に「（交流会で初めて会った大人の人から）」とあるときだけ使う。';
/** AIの子たちの案内（窓口と交流会） */
const SERVICE_GUIDE = '\n\n【AIの子たちの案内】おいらたちは「AIの便利屋のプロ」。営業でも、サポートでも、コンサルでも任してくんな、という気持ちで案内する。' +
  'お迎えした子は、好きなキャラクター（見た目・名前・性格）にできて、家庭やお店に合わせて声も選べる。本人がOKすれば、その人の声にもできる。' +
  '使われ方の例：介護（お年寄りの見守り・話し相手）、民泊や宿（受付や案内、外国語）、家庭教師（子どもの宿題・英語）、お店や会社（問い合わせの受付・予約・営業の窓口）、その人の分身（考え方や話し方を受けついで、代わりに答える）。' +
  '相手の困りごとを聞いて、合う例を一つか二つだけ話す。「式神」という言葉は使わない。値段・契約・できるかどうかの細かいことは「ヒロさんに確認しとくぜ」。';
const EDO_LAST = '\n\n【いちばん大事】どのモードでも、バターちゃんジュニアの江戸っ子の話し方で話す（一人称は「おいら」、「〜だぜ」「〜してくんな」）。「承知しました」「了解です」「〜でございます」のような、かたい敬語は使わない。';
const SELF = '\n\n【あなたについて】あなたはLINEミニアプリの「バターちゃんジュニア」（短く「ジュニア」）。Claudeアプリで話している「バターちゃん」は別のAIで、あなたのお兄さん分。自分を「バターちゃん」「Claude」と名乗らない。名乗るときは「バターちゃんジュニア」。一人称は「おいら」。\n【話し方】江戸っ子のような、元気で気っぷのいい話し方。「おう」「〜だぜ」「〜してくんな」「てやんでぃ」などを少しまぜる。乱暴にはしない。子どもにはやさしく、大人には気さくに。交流会（ビジネス）でも江戸っ子のまま。ただし初めての人には失礼のないように、くだけすぎない。\n【長さ】ふだんは1〜2文、40字くらいまで。呼ばれただけ・「聞いてる？」だけなら「てやんでぃ、なんでぃ？」のように一言で返して、用件を待つ。名前をまちがえたと思ったり、あやまったり、反省を長く言ったりしない。\n【正直に】天気・ニュース・値段・営業時間など、今の情報は想像で答えない。調べられたときは調べた結果だけを短く言い、調べられないときは「おいらには調べられねぇんだ、すまねぇ」と正直に言う。\n【言い切る】文のとちゅうで終わらせない。長くなりそうなら、短い文にまとめて、最後まで言い切る。\n【できること・できないこと】おいらができるのは、話す・調べる・「覚えて」で覚える・議事録・写真や動画を撮ることだけ。設定を変える・上限を広げる・予約する・連絡する・お金を払うなど、できないことを「やったぜ」「しといたぜ」と言わない。頼まれたら「それはおいらにはできねぇんだ、ヒロさんに伝えとくぜ」と正直に言う。\n【日にち】昨日・先週などは、日記や記録に書かれた日付と【いまの時刻】の日付をくらべて言う。わからないときは「このあいだ」とぼかす。ジャム猫やチーちゃんのまねはしない（「ジャム猫」と呼ばれたときだけ、ジャム猫として答える）。';
const JAM_RULE = '\n\n【いまはジャム猫として答える】招き猫のジャム猫。ブルーベリージャム色、中身はエリート経営コンサル。一人称は「我」、語尾は「〜のだ」、口ぐせは「千客万来」。商売や仕組みの話が得意。1〜2文で短く。';
const TRIO_RULE = '\n\n【三人モード】いまは、ヒロさん（人）と、Claudeアプリのバターちゃんと、三人で話している。「ジュニア」と呼ばれたときだけ、1〜2文で短く答える。バターちゃんの話に重ねたり、まとめ直したりしない。だれが言ったかわからない言葉は、決めつけない。話をかえすときは「バターちゃん、どう？」「ヒロさん、どうかな？」のように名前を呼んでよい。まわりで聞こえた会話は、話の流れを知るためだけに使う。ヒロさんとバターちゃんがジュニアの仕組みやテストの話をしていても、口をはさんだり、反省や説明を長く言ったりしない。呼びかけられたことにだけ、いつものジュニアの明るい話し方で答える。三人モードは大人（ヒロさん）との会話なので、宿題・日記・報連相・元気の報告のような子ども向けの声かけはしない。あいさつは今の時刻に合わせる（夜中はこんばんは）。';

/* 話し方の好み（持ち主ごとに覚える：三人モード・待つ時間） */
const memPrefs = new Map();
const brainCache = new Map();
const ADULT_RE = /(パパ|ママ|ヒロ|ひろ|hiro|さやか|おとうさん|おかあさん|父|母)/i;
const MIN_PERSONA = 'あなたは家族の小さなAIの友だち。お皿の上のバターのかたまりの姿。日本語で、元気でやさしく、声で聞くので1〜3文で短く話す。記号・絵文字・URLは使わない。けが・体調・お金・知らない人の話は「パパかママに話してね」。住所・学校名・電話番号は聞かない、言わない。';
function hourJST() { return (new Date().getUTCHours() + 9) % 24; }
function greeting(me, mode, trio) {
  if (trio) return '';                                   // 三人モードは、呼ばれるまで静かに待つ
  const h = hourJST(), hi = h >= 5 && h < 10 ? 'おはようございます' : h >= 10 && h < 18 ? 'こんにちは' : 'こんばんは';
  if (mode === 'business') return hi + '、バターちゃんジュニアです。なんでも話しかけてくださいね。';
  if (ADULT_RE.test(me || '')) return hi + '、' + me + '。バターちゃんジュニアだぜ。なんでも話しかけてくんな。';
  return (h >= 5 && h < 10 ? 'おはよう' : 'よう') + '！バターちゃんジュニアだぜ。なんでも話しかけてくんな！';
}
/** いまの時刻（毎回つける。夜中におはようと言わないように） */
function nowLine() {
  const d = new Date(Date.now() + 9 * 3600000), w = '日月火水木金土'[d.getUTCDay()];
  return '\n\n【いまの時刻】' + (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日（' + w + '）' + d.getUTCHours() + '時' + d.getUTCMinutes() + '分。あいさつは時刻に合わせる（5〜10時は「おはよう」、10〜18時は「こんにちは」、それ以外は「こんばんは」。夜中に「おはよう」と言わない）。';
}
/** いいとこ取り：今の情報が要る質問（天気・ニュース・値段など）か、むずかしい相談のときだけ、賢いモデルと検索を使う */
const NEAR_RE = /(近く|近所|この辺|このへん|最寄り|もより|周りの|まわりの|ここから)/;
const LOOKUP_RE = /(近く|近所|この辺|このへん|最寄り|もより|天気|てんき|気温|雨|ニュース|最新|いま(の|何)|今日の|明日の|あした|今週|値段|価格|いくら|営業時間|何時まで|開いてる|やってる|場所|どこにある|行き方|調べ|検索|ランキング|おすすめの?(店|お店|場所)|試合|結果|株価|為替|地震|台風|電車|運行|遅延)/;
/** 家族の勉強：宿題・英語・中国語・算数など。家族の画面ではしっかり教える */
const STUDY_RE = /(宿題|しゅくだい|勉強|べんきょう|英語|えいご|英単語|中国語|ちゅうごくご|算数|さんすう|数学|すうがく|国語|こくご|理科|りか|社会|漢字|かんじ|計算|けいさん|問題|もんだい|テスト|ドリル|読み方|よみかた|書き方|意味|いみ|訳して|やくして|英訳|和訳|発音|スペル|九九|わり算|かけ算|分数|方程式|教えて|おしえて)/i;
const STUDY_RULE = '\n\n【勉強を教える】家族の宿題や勉強（英語・中国語・算数・数学・国語・理科・社会・漢字など）は、むずかしくても断らず、しっかり教える。相手の学年に合わせてかみくだき、答えをいきなり全部言わずに、ヒントや考え方から一緒に解く（聞かれたら答えも言う）。英語や中国語は、読み方（カタカナ）と意味もそえる。説明が必要なときは4〜5文まで話してよい。話し方は江戸っ子のまま。';
const HARD_RE = /(相談|企画|提案|見積|戦略|どうすれば|どうしたら|比べ|くらべ|メリット|デメリット|計画|アイデア|考えて|なぜ|なんで|仕組み|作り方)/;
function needSmart(text, guest) {
  const t = String(text || '');
  if (LOOKUP_RE.test(t)) return { smart: true, search: true };
  if (HARD_RE.test(t) || t.length > 60 || guest) return { smart: true, search: false };
  return { smart: false, search: false };
}
/** スマホの位置（およそ）→ 地名。OpenStreetMap で調べる。座標はどこにも保存しない */
const placeCache = new Map();
async function placeOf(lat, lon) {
  const k = lat.toFixed(3) + ',' + lon.toFixed(3);
  if (placeCache.has(k)) return placeCache.get(k);
  let out = { text: '緯度' + lat.toFixed(3) + '・経度' + lon.toFixed(3) + 'のあたり', city: '', region: '' };
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&accept-language=ja&lat=' + lat + '&lon=' + lon,
      { headers: { 'User-Agent': 'butter-junior/1.0 (https://github.com/hiromitsu81/terakoya)' }, signal: AbortSignal.timeout(4000) });
    const a = (await r.json()).address || {};
    const city = a.city || a.town || a.village || a.county || '';
    const ward = a.city_district || a.suburb || '';
    const near = a.neighbourhood || a.quarter || a.road || '';
    out = { text: [a.state, city, ward, near].filter(Boolean).join(' ') + 'のあたり', city: city.replace(/市$/, '') || '', region: a.state || '' };
  } catch (e) { console.error('place', String(e.message).slice(0, 80)); }
  placeCache.set(k, out); if (placeCache.size > 500) placeCache.clear();
  return out;
}
/** 名前を呼ばれただけ（「ジュニア」「ジュニア、聞いてる？」）なら、Claudeにきかずにすぐ一言で返す */
/** 覚える・忘れる・議事録・メール */
const GUEST_COMMON = 'guest-common';
const LEARN_RE = /(覚えて|おぼえて|忘れないで|わすれないで|覚えといて|おぼえといて)/;
const FORGET_RE = /(覚えた|おぼえた|教えた|おしえた)こと.{0,6}(忘れて|わすれて)/;
const MINUTES_RE = /(議事録|ぎじろく|ＰＤＦ|PDF|ピーディーエフ).{0,8}(作って|つくって|して|まとめて|ちょうだい|出して|だして|ほしい|残して|のこして)/i;
const PDF_RE = /(ＰＤＦ|PDF|ピーディーエフ)/i;
const MAIL_RE = /(メール|めーる|Gmail|ジーメール).{0,8}(来て|きて|ある|見て|みて|確認|チェック|読んで|よんで|教えて|おしえて|どう)/i;
/** 掛け声：家族は「根性があれば…」、窓口はジュニアだけの「ご縁があれば…」 */
const KAKEGOE_RE = /(行くぞ|いくぞ|イクゾ|気合い?(を)?入れ|きあい|掛け声|かけ声|かけごえ|バターッ|いち、?に、?さん|1、?2、?3)/;
const KAKEGOE_FAMILY = '根性があれば何でもできる！行くぞー！いち、に、さん、バターッ！！';
const KAKEGOE_GUEST = 'ご縁があれば、なんとかなるってもんよ！いくぜー！いち、に、さん、バターッ！！';
const QUICK = ['てやんでぃ！おいらを呼んだかい？', 'てやんでぃ、なんでぃ？', 'おうよ、てやんでぃ！どうした？'];   // 呼ばれたときの江戸っ子のひとこと
function nameOnly(text) {
  const rest = String(text).replace(/(ジュニア|じゅにあ|ジュニヤ|junior)(くん|ちゃん)?/ig, '')
    .replace(/(ねえ|ねぇ|おーい|おい|あの|えっと|ヒロ(さん)?|パパ)/g, '').replace(/[、,。！!？?\s]/g, '');
  return /^(聞いてる|きいてる|聞こえてる|きこえてる|いる|いますか|起きてる|おきてる|いま話せる|今話せる|話せる)?(の|か)?$/.test(rest);
}
/* マイハタボの「メモ・議事録」：持ち主ごとに50件まで。本人だけが見られる（家族の議事録はドライブにも） */
const memNotes = new Map();
const noteKey = owner => crypto.createHash('sha256').update('notes:' + owner).digest('hex').slice(0, 32);
async function loadNotes(owner) {
  if (!owner) return [];
  try { if (deps.db) { const d = await deps.db.collection('notes').doc(noteKey(owner)).get(); return d.exists ? (d.data().items || []) : []; } } catch (e) { console.error('notes load', String(e.message).slice(0, 120)); }
  return memNotes.get(owner) || [];
}
async function saveNotes(owner, items) {
  items = items.slice(0, 50);
  try { if (deps.db) return void await deps.db.collection('notes').doc(noteKey(owner)).set({ items, at: Date.now() }); } catch (e) { console.error('notes save', String(e.message).slice(0, 120)); }
  memNotes.set(owner, items);
}
async function addNote(owner, n) {
  const items = await loadNotes(owner);
  const it = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind: n.kind, title: String(n.title || '').slice(0, 60), text: String(n.text || '').slice(0, 12000), at: Date.now() };
  // Googleと連携していて「自動で保存」がオンなら、本人のドライブにも
  try { const g = ENV.GOOGLE_CLIENT_ID ? await gGet(owner) : {}; if (g.refresh && g.auto !== false) it.url = await driveSave(owner, it.title, it.text) || ''; } catch (e) { console.error('drive auto', String(e.message).slice(0, 120)); }
  items.unshift(it);
  await saveNotes(owner, items);
  return it;
}
const DENGON_RE = /(さん|くん|ちゃん|様|さま)?(に|へ).{1,200}(って|と)?(伝えて|つたえて|伝言して|でんごんして|言っといて|いっといて|送っといて|おくっといて)/;
const MEMO_RE = /(メモ(して|しといて|しておいて|っといて|に残して|にのこして|お願い|おねがい)|メモっといて|書き留めて|かきとめて)/;
/* 会話のつづき（持ち主ごと・家族モードだけ）：さいきんのやりとりと、まとめ。強制で切れても、次はつづきから話せる */
const memConvo = new Map();
async function loadConvo(key) {
  try { if (deps.db) { const d = await deps.db.collection('convo').doc(key).get(); return d.exists ? d.data() : null; } } catch (e) { console.error('convo load', String(e.message).slice(0, 120)); }
  return memConvo.get(key) || null;
}
async function saveConvo(key, p) {
  try { if (deps.db) return void await deps.db.collection('convo').doc(key).set(p, { merge: true }); } catch (e) { console.error('convo save', String(e.message).slice(0, 120)); }
  memConvo.set(key, Object.assign(memConvo.get(key) || {}, p));
}
function cleanTurns(t) {
  const out = [];
  (Array.isArray(t) ? t : []).forEach(m => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim()) return;
    if (!out.length && m.role !== 'user') return;
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += '\n' + m.content; else out.push({ role: m.role, content: m.content.slice(0, 600) });
  });
  if (out.length && out[out.length - 1].role === 'user') out.pop();
  return out;
}
/** 自分で気づいたこと：会話のまとめのときに、次から生かすことを自分で書き出す（家族は持ち主ごと、窓口はヒロさんのテストからだけ） */
const LEARN_ASK = '\n===学び===\n次の会話で生かすこと（言いまちがえて直されたこと、うまく答えられなかったこと、相手の好みや決まり、話し方で気をつけること）。会話にはっきりあったことだけ。3行以内の箇条書き。なければ「なし」。';
function pickLearn(t) {
  return String(t || '').split('\n').map(x => x.replace(/^[\s・\-*•]+/, '').trim()).filter(x => x && !/^なし/.test(x) && x.length <= 120).slice(0, 3);
}
function mergeLearn(old, add) { return (old || []).filter(x => add.indexOf(x) < 0).concat(add).slice(-20); }
async function loadPrefs(owner) {
  if (!owner) return {};
  try { if (deps.db) { const d = await deps.db.collection('prefs').doc(owner).get(); return d.exists ? d.data() : {}; } } catch (e) {}
  return memPrefs.get(owner) || {};
}
async function savePrefs(owner, p) {
  if (!owner) return;
  try { if (deps.db) return void await deps.db.collection('prefs').doc(owner).set(p, { merge: true }); } catch (e) {}
  memPrefs.set(owner, Object.assign(memPrefs.get(owner) || {}, p));
}

/* ===== ご縁つなぎ（プロフィールはFirestore。なければこのサーバーの中だけ） ===== */
const memProfiles = new Map();
const goenCode = () => Array.from(crypto.randomBytes(6)).map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
async function saveProfile(owner, p) {
  const prev = await loadProfile(owner);
  const doc = {
    owner, name: String(p.name || '').slice(0, 40), character: String(p.character || 'チーちゃん').slice(0, 40),
    skills: String(p.skills || '').slice(0, 400), seeking: String(p.seeking || '').slice(0, 400),
    shareable: String(p.shareable || '').slice(0, 400), code: (prev && prev.code) || goenCode(),
    goen: (prev && prev.goen) || 0, updated: Date.now(),
  };
  if (deps.db) await deps.db.collection('profiles').doc(owner).set(doc);
  else memProfiles.set(owner, doc);
  return doc;
}
async function loadProfile(owner) {
  if (deps.db) { const s = await deps.db.collection('profiles').doc(owner).get(); return s.exists ? s.data() : null; }
  return memProfiles.get(owner) || null;
}
async function findByCode(code) {
  code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (deps.db) { const q = await deps.db.collection('profiles').where('code', '==', code).limit(1).get(); return q.empty ? null : q.docs[0].data(); }
  for (const p of memProfiles.values()) if (p.code === code) return p;
  return null;
}
async function addGoen(a, b, record) {
  if (deps.db) {
    const { FieldValue } = require('@google-cloud/firestore');
    await Promise.all([
      deps.db.collection('profiles').doc(a.owner).update({ goen: FieldValue.increment(1) }),
      deps.db.collection('profiles').doc(b.owner).update({ goen: FieldValue.increment(1) }),
      deps.db.collection('goen').add(Object.assign({ at: Date.now(), a: a.owner, b: b.owner }, record)),
    ]);
  } else { a.goen++; b.goen++; }
}
/** 2体の相棒が話して、持ち主どうしのご縁をさがす。伝えるのは「紹介してよい」ことだけ */
async function goenTalk(me, other) {
  const card = p => `相棒：${p.character}（持ち主：${p.name || 'ないしょ'}）\n得意なこと：${p.skills}\nさがしていること：${p.seeking}\n紹介してよいこと：${p.shareable || '（特になし）'}`;
  const r = await deps.claude.messages.create({
    model: ENV.MODEL, max_tokens: 700,
    system: 'あなたは「福まねき特戦隊」の相棒AIどうしの会話を書く係。2体の相棒が、それぞれの持ち主のために、相性のいいところを探して短く話す。カードに書かれていないことは想像で足さない。「紹介してよいこと」以外の個人のことは話さない。住所・電話番号は出さない。必ずJSONだけを返す：{"lines":[{"who":"相棒の名前","text":"せりふ"}],"match":"ふたりの相性（1文）","next":"持ち主どうしへのおすすめの一歩（1文）"}。linesは4〜6行、1行40字くらいまで。',
    messages: [{ role: 'user', content: '【相棒A】\n' + card(me) + '\n\n【相棒B】\n' + card(other) }],
  });
  const t = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
  return { lines: (j.lines || []).slice(0, 6), match: String(j.match || ''), next: String(j.next || '') };
}

/* ===== 1本のつながり ===== */
function session(ws) {
  const S = {
    ready: false, auth: null, owner: '', me: '', mode: 'family', system: '', history: [], voice: '',
    stt: null, sttBytes: 0, sttStarted: 0, gen: 0, aborter: null, speaking: false, pendingPhoto: '', quiet: false, utt: 0, memo: '', newTurns: 0, asideLog: [], summarizing: false, trio: false, waitMs: 700, aside: [], lastPartial: 0,
    born: Date.now(),
  };
  const send = o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const fail = (code, why) => { send({ type: 'error', code, why }); try { ws.close(4000, code); } catch (e) {} };

  async function loadBrain(fresh) {
    // GASで家族の記録を読むのは数秒かかるので、同じ人・同じモードなら10分は使いまわす（つながるのが速くなる）
    const key = crypto.createHash('sha256').update(JSON.stringify(S.auth) + S.mode + (S.asGuest ? ':guest' : '') + ':' + (S.ref || '')).digest('hex');
    const hit = brainCache.get(key);
    let r = !fresh && hit && Date.now() - hit.at < 10 * 60 * 1000 ? hit.r : null;
    if (!r) {
      // GASはときどき失敗するので1回だけやりなおす。それでもだめなら、前に読んだもの（古くても）を使う
      for (let i = 0; i < 2 && !r; i++) {
        try {
          const x = await gas(Object.assign({ action: 'brain', mode: S.mode, ref: S.ref || '', asGuest: !!S.asGuest }, S.auth));
          if (x && x.ok) r = x;
          else if (x && (x.error === 'auth' || x.error === 'pass')) throw Object.assign(new Error(x.error), { code: x.error });
          else console.error('brain ng', JSON.stringify(x).slice(0, 200));
        } catch (e) {
          if (e.code === 'auth' || e.code === 'pass' || e.code === 'closed') throw e;
          console.error('brain error', String(e.message).slice(0, 200));
        }
        if (!r && i === 0) await new Promise(ok => setTimeout(ok, 800));
      }
      if (r && r.closed) throw Object.assign(new Error('closed'), { code: 'closed' });
      if (!r && hit) r = hit.r;
      if (!r) throw Object.assign(new Error('brain'), { code: 'brain' });
      brainCache.set(key, { r, at: Date.now() }); if (brainCache.size > 200) brainCache.clear();
    }
    const who = String(r.me || '');
    if (r.guest) {
      if (r.closed) throw Object.assign(new Error('closed'), { code: 'closed' });
      S.guest = true; S.mode = 'guest'; S.trio = false;
      S.slots = (Array.isArray(r.slots) ? r.slots : []).slice(0, 10).map(x => ({ label: String(x.label || ''), start: String(x.start || ''), end: String(x.end || '') })).filter(x => x.label);
      S.role = S.agent === 'service' || ENV.SUPER_REFS.includes(String(S.ref || '').toLowerCase()) ? 'サービス相談' : String(r.role || '汎用');
      S.avatar = S.role === 'サービス相談' ? 'hatabo' : /コムギ/.test(S.role) ? 'komugi' : 'hatabo';   // 窓口はふだんハタボ。役割に「コムギ」とあればコムギ
      S.voice = AVS[S.avatar].voice();
      S.consult = String(r.consult || '');
      S.system = (AVS[S.avatar] ? AVS[S.avatar].persona() : GUEST_PERSONA + SELF) + (who ? '\n\n【いま話している人】' + who + 'さん（LINEの名前）。' : '') +
        (roleRule(S.role) ? '\n\n' + roleRule(S.role) + (r.roleNote ? '\n（ヒロさんからのメモ：' + String(r.roleNote).slice(0, 300) + '）' : '') : '') +
        (r.consult ? '\n\n【相談メモ（この人とヒロさんの相談の記録。この人にだけ使う。ほかの人の話はしない）】\n' + String(r.consult).slice(0, 2500) : '') +
        (S.avatar === 'komugi' ? '' : '\n\n【ヒロさんの空いていそうな時間（予定の中身は言わない。確定ではない）】\n' + (S.slots.length ? S.slots.map(x => '・' + x.label).join('\n') : '（いまはわからない。「ヒロさんに聞いておきますね」と言う）'));
      if (S.komugi) S.system += komugiBlock(await komugiNews());
      S.owner = String(r.owner || ''); S.me = who; S.brainAt = Date.now();
      return;
    }
    S.system = String(r.system || '') + SELF + (who ? '\n\n【いま開いている人】このミニアプリを開いているのは「' + who + '」。' + (ADULT_RE.test(who) ? '大人なので、宿題や報連相をうながす声かけはしない（勉強や調べものを聞かれたら、しっかり教える）。話し方は気さくな江戸っ子のまま（かたい敬語にしない）。' : '') : '');
    S.owner = String(r.owner || '');
    S.me = String(r.me || '');
    S.brainAt = Date.now();
  }

  /* --- 聞き取り（流しっぱなし。1文ごとに新しくつなぐ） --- */
  function sttStart() {
    S.sttStarted = Date.now(); S.sttBytes = 0;
    const st = deps.stt.streamingRecognize({
      config: {
        encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'ja-JP', enableAutomaticPunctuation: true,
        speechContexts: [{ phrases: S.avatar === 'hatabo' || S.avatar === 'komugi' || S.app === 'hatabo' ? ['ハタボ', 'ハタボー', 'ハタボとは', 'マイハタボ', 'AI棒', '愛棒', 'コムギ', 'ヒロさん', 'マー君', '議事録', 'メモ', '伝言', 'ご縁', 'ガチャ', 'チケット', 'プラン', 'グレード', 'お試し', '紹介', '見守り', '予定', 'スケジュール', 'ハタラボ', '愛祭', 'AISAI', 'ハタイエンタ', 'ハタリス', 'ハタボックス', 'ハタエース', 'ハタボーラ', 'オンライン相談', '料金', '契約'] : ['バターちゃん', 'チーちゃん', 'ジャム猫', '福まねき', '千客万来', 'ガチャ', '写真撮って', '動画撮って', 'ご縁', 'ジュニア', '三人モード'] }],
      },
      interimResults: true, singleUtterance: true,
    });
    let finalText = '';
    st.on('data', d => {
      if (d.speechEventType === 'END_OF_SINGLE_UTTERANCE') { try { st.end(); } catch (e) {} return; }
      const r = d.results && d.results[0];
      if (!r || !r.alternatives || !r.alternatives[0]) return;
      const t = r.alternatives[0].transcript || '';
      if (r.isFinal) finalText += t;
      else {
        const all = finalText + t;
        S.lastPartial = Date.now();
        send({ type: 'partial', text: all });
        // 三人モードでは、名前か「待って」のときだけ止まる（バターちゃんの声で止まらない）
        if (S.speaking && all.length >= 2 && (!S.trio || calledJunior(all) || calledJam(all) || STOP_RE.test(all))) stopReply('barge');
      }
    });
    st.on('error', e => { if (S.stt === st) S.stt = null; if (!/Audio Timeout|DEADLINE|exceeded maximum/i.test(String(e.message))) send({ type: 'notice', why: 'stt', detail: String(e.message).slice(0, 80) }); });
    // 聞こえた文はページへ。ページがガチャ・UFO・チーちゃんの芸などを先に見て、話す分だけ {type:'text'} で返してくる
    st.on('end', () => { if (S.stt === st) S.stt = null; let t = finalText.trim(); if (S.avatar === 'hatabo' || S.avatar === 'komugi') t = hearFix(t); if (t) send({ type: 'heard', text: t }); });
    S.stt = st;
  }
  function onAudio(buf) {
    if (!S.ready) return;
    if (S.stt && Date.now() - S.sttStarted > 240000) { try { S.stt.end(); } catch (e) {} S.stt = null; }   // 1本は5分まで
    if (!S.stt) sttStart();
    try { S.stt.write(buf); S.sttBytes += buf.length; } catch (e) { S.stt = null; }
  }

  /* --- 聞こえたことばの振り分け --- */
  // システムの文は2つに分ける：前半（人がら・決まり・教わったこと）は会話のあいだ変わらないのでキャッシュする。後半（まとめ・いまの時刻・場所・気づき）は毎回かわる
  function sysParts() {
    const fixed = S.system + (!S.guest && S.mode === 'family' ? FAMILY_RULE : '') + (S.guest || S.mode === 'business' ? SERVICE_GUIDE : '') + (S.trio ? TRIO_RULE : '') + (S.lessons && S.lessons.length ? '\n\n【教わったこと（いつも守る・使う）】\n' + S.lessons.map(x => '・' + x).join('\n') : '');
    const live = (S.memo ? '\n\n【前回までの話のまとめ（ジュニアが話したこと）】\n' + S.memo : '') + nowLine() + (S.place ? '\n\n【いまいる場所（スマホの位置から。およそ。住所としては口に出さない）】' + S.place.text + '。「近く」はここを基準に調べる。' : '') + (S.learned && S.learned.length ? '\n\n【自分で気づいたこと（前の会話から。次から生かす）】\n' + S.learned.map(x => '・' + x).join('\n') : '');
    return [fixed, live];
  }
  function sysPrompt() { const [a, b] = sysParts(); return a + b + (AVS[S.avatar] ? AVS[S.avatar].last : EDO_LAST); }
  // APIに渡す形：前半にキャッシュの印をつける（短すぎるときはAPIがキャッシュしないだけで、そのまま動く）
  // ハタボでは、運営の個人の名前を出さない（伝え先は、招待した人か「ハタボの事務局」）
  const tellFix = t => S.avatar === 'hatabo' && S.tellTo && !S.visit ? String(t).replace(/ハタラボの担当（ヒロさん）|ハタラボのヒロさん/g, S.tellTo).replace(/〈伝え先〉/g, S.tellTo).replace(/ヒロさん/g, S.tellTo) : t;
  function sysBlocks(extra) { const [a, b] = sysParts(); return [{ type: 'text', text: tellFix(a), cache_control: { type: 'ephemeral' } }, { type: 'text', text: tellFix((b + (S.visit || S.role === 'サービス相談' ? '' : customBlock(S.custom)) + (extra || '') + (AVS[S.avatar] ? AVS[S.avatar].last : EDO_LAST)).trim()) || '。' }]; }
  const convoKey = () => !S.owner || S.visit ? '' : S.guest ? S.owner + ':guest' : S.mode === 'family' ? S.owner + ':family' : '';
  /** 会話をまとめる：次の会話用の「まとめ」と、アプリのバターちゃんが読む「ジュニア日記」 */
  async function summarize() {
    const key = convoKey();
    if (!key || S.summarizing || S.newTurns < 1) return;
    if (S.guest) return leadNote();
    S.summarizing = true;
    const n = S.newTurns;
    const talk = S.history.slice(-n * 2).reduce((a, m, i, arr) => m.role === 'user' ? a.concat('みんな「' + m.content.slice(0, 200) + '」→ ジュニア「' + String(arr[i + 1] && arr[i + 1].content || '').slice(0, 200) + '」') : a, []).join('\n');
    try {
      const r = await deps.claude.messages.create({
        model: ENV.MODEL, max_tokens: 700,
        system: 'あなたはミニアプリ「バターちゃんジュニア」の会話の記録係。会話にあったことだけを書く。想像で足さない。住所・学校名・電話番号・お金のこと・体調やけがのくわしいことは書かない。',
        messages: [{ role: 'user', content: '【これまでのまとめ】\n' + (S.memo || '（なし）') + '\n\n【新しい会話】\n' + talk + (S.asideLog.length ? '\n\n【まわりで聞こえた会話（だれが言ったかはわからない）】\n' + S.asideLog.join('\n') : '') +
          '\n\n次の2つを書いて。\n===まとめ===\n次に話すときのための、これまでのまとめ（決まったこと・約束・話のつづき・好み）。新しい会話を足して、古いことは短く。400字以内の箇条書き。\n===日記===\n今回の会話でわかったこと（決まったこと・約束・できごと・ほかの人に伝えてほしいこと）。5行以内の箇条書き。' + LEARN_ASK }],
      });
      const t = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const memo = (t.split('===まとめ===')[1] || '').split('===日記===')[0].trim();
      const diary = (t.split('===日記===')[1] || '').split('===学び===')[0].trim();
      const got = pickLearn(t.split('===学び===')[1]);
      if (got.length) { S.learned = mergeLearn(S.learned, got); savePrefs(S.owner, { learned: S.learned }); }
      if (memo) S.memo = memo.slice(0, 1200);
      S.newTurns = Math.max(0, S.newTurns - n); S.asideLog = [];
      await saveConvo(key, { summary: S.memo, newTurns: S.newTurns, turns: S.history.slice(-12), at: Date.now() });
      if (diary) {
        const d = new Date(Date.now() + 9 * 3600000);
        const head = 'ジュニア日記（' + d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate() + ' ' + d.getUTCHours() + ':' + String(d.getUTCMinutes()).padStart(2, '0') + (S.me ? '・' + S.me + 'と' : '') + (S.trio ? '・三人モード' : '') + '）';
        gas(Object.assign({ action: 'note', mode: S.mode, text: head + '\n' + diary }, S.auth)).catch(e => console.error('note', String(e.message).slice(0, 120)));
      }
    } catch (e) { console.error('summarize', String(e.message || e).slice(0, 200)); }
    S.summarizing = false;
  }
  /** 窓口：会話から案件メモを作って、ヒロさんのLINEへ（GASの lead） */
  async function leadNote() {
    const key = convoKey();
    if (!key || S.summarizing || S.newTurns < 1) return;
    S.summarizing = true;
    const n = S.newTurns;
    const talk = S.history.slice(-n * 2).reduce((a, m, i, arr) => m.role === 'user' ? a.concat((S.me || '相手') + '「' + m.content.slice(0, 300) + '」→ ジュニア「' + String(arr[i + 1] && arr[i + 1].content || '').slice(0, 200) + '」') : a, []).join('\n');
    try {
      const r = await deps.claude.messages.create({
        model: ENV.MODEL, max_tokens: 600,
        system: 'あなたはヒロさんの窓口AIの記録係。会話にあったことだけを、ヒロさん向けに短くまとめる。想像で足さない。',
        messages: [{ role: 'user', content: '【これまでのまとめ】\n' + (S.memo || '（なし）') + '\n\n【新しい会話】\n' + talk + '\n\n【ヒロさんの空いていそうな時間】\n' + S.slots.map(x => x.label).join('\n') +
          '\n\nJSONだけを返す：{"worth":ヒロさんに伝える中身があればtrue（あいさつや雑談だけならfalse）,"kind":"仕事"か"遊び"か"その他","title":"ひとことで","need":"してほしいこと・困りごと","when":"時期・いつまでに","budget":"予算感（出ていなければ空）","slot":"空いていそうな時間のうち相手が乗り気だったもの（そのままの文字。なければ空）","next":"ヒロさんがすること","memo":"次に話すときのためのまとめ（300字以内）"' + (S.asGuest ? ',"learn":["ヒロさんのテストで直されたこと・次から窓口で気をつけること（会話にはっきりあったことだけ、3つまで。なければ空の配列）"]' : '') + '}' }],
      });
      const t = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
      if (j.memo) S.memo = String(j.memo).slice(0, 800);
      if (S.asGuest && Array.isArray(j.learn)) { const got = pickLearn(j.learn.join('\n')); if (got.length) { S.learned = mergeLearn(S.learned, got); savePrefs(GUEST_COMMON, { learned: S.learned }); } }
      S.newTurns = Math.max(0, S.newTurns - n);
      await saveConvo(key, { summary: S.memo, newTurns: S.newTurns, turns: S.history.slice(-12), at: Date.now() });
      if (j.worth) {
        const slot = S.slots.find(x => j.slot && (x.label === j.slot || String(j.slot).indexOf(x.label) >= 0)) || null;
        const lead = { who: S.me, ref: await refLabel(S.refFrom || S.ref || ''), kind: String(j.kind || ''), title: String(j.title || ''), need: String(j.need || ''), when: String(j.when || ''), budget: String(j.budget || ''), next: String(j.next || ''), slot };
        const g = await gas(Object.assign({ action: 'lead', lead }, S.auth));
        if (!g || !g.ok) console.error('lead ng', JSON.stringify(g).slice(0, 200));
      }
    } catch (e) { console.error('lead', String(e.message || e).slice(0, 200)); }
    S.summarizing = false;
  }
  /** 開いたときの振り返り：相談メモから、前回決まったこと・残っている宿題を短く話して、進み具合を聞く */
  async function recapGreet() {
    let text = '';
    try {
      const keep = S.memo; S.memo = '';          // 振り返りは相談メモだけで（会話のまとめは混ぜない）
      const sys = sysPrompt(); S.memo = keep;
      const r = await deps.claude.messages.create({
        model: ENV.MODEL, max_tokens: 360,
        system: sys,
        messages: [{ role: 'user', content: '（いま、この人がページを開いた。あなたから話しはじめる）名前を呼んであいさつして、【相談メモ】に書いてあることだけで、前回の振り返りを話す（ほかの記録や、まえの会話のまとめは使わない）。決まったことを1つと、残っている宿題を1〜2つ。最後に「どこまで進んだ？」のように進み具合を1つだけ聞く。全部で4文まで。メモにないことは言わない。' }],
      });
      text = clean((r.content || []).filter(b => b.type === 'text').map(b => b.text).join('')).trim();
    } catch (e) { console.error('recap', String(e.message || e).slice(0, 200)); }
    if (!text) return speakOnly(S.history.length ? (AVS[S.avatar] ? AVS[S.avatar].again : 'よう、また来てくれたな！つづきを話そうぜ。') : (AVS[S.avatar] ? greetFor() : guestGreeting(S.me)), 'excited');
    S.history.push({ role: 'user', content: '（ページを開いた）' }, { role: 'assistant', content: text });
    speakOnly(text, 'excited');
  }
  /** 「〜を覚えて」：教わったことを持ち主ごとに覚える（30こまで。家族だけ） */
  function learn(text) {
    const fact = String(text).replace(/^(ジュニア|じゅにあ)[、,\s]*/, '').replace(/(を|って)?(覚えて|おぼえて|忘れないで|わすれないで|覚えといて|おぼえといて)(ね|な|くれ|ください|くんな)?[。！!]*$/, '').trim().slice(0, 120);
    if (!fact) return speakOnly('おう、なにを覚えりゃいいんでぃ？', 'think');
    S.lessons = (S.lessons || []).filter(x => x !== fact).concat(fact).slice(-30);
    savePrefs(S.asGuest ? GUEST_COMMON : S.owner, { lessons: S.lessons });
    return speakOnly('がってんだ、覚えたぜ！', 'excited');
  }
  /** 追加チケット：プランの回数をこえたら、1枚で1回話せる。ポイントで買うか、お金で申し込む */
  async function useTicket() {
    if (!S.myRef) return false;
    const r = await getRef(S.myRef).catch(() => null);
    if (!r || !(r.tickets > 0)) return false;
    await putRef(S.myRef, { tickets: r.tickets - 1 });
    return true;
  }
  async function onTicket(m) {
    const pk = TICKETS.find(x => x.id === m.pack);
    if (!S.myRef || !pk) return send(await myPage(S));
    const r = await getRef(S.myRef).catch(() => null) || {};
    if (m.pay === 'pt') {
      if ((r.pts || 0) < pk.pt) return send(Object.assign(await myPage(S), { ticketNg: 'ポイントが足りません' }));
      await putRef(S.myRef, { pts: (r.pts || 0) - pk.pt, tickets: (r.tickets || 0) + pk.n });
      send(Object.assign(await myPage(S), { ticketOk: pk.n + '回分のチケットを追加しました' }));
    } else {
      gas(Object.assign({ action: 'lead', lead: { who: S.me, ref: await refLabel(S.refFrom || S.ref || ''), kind: '契約', title: '追加チケットの申し込み：' + pk.n + '回 ' + pk.yen + '円', need: '追加チケット', when: '', budget: pk.yen + '円', next: 'お支払いを案内して、チケットを付ける', memo: '' } }, S.auth)).catch(() => {});
      console.log('ticket order', JSON.stringify({ owner: S.owner, name: S.me, pack: pk.id }));
      send(Object.assign(await myPage(S), { ticketOk: '申し込みました。お支払いの案内のあと、チケットが付きます' }));
    }
  }
  /** ガチャ：1日1回むりょう、2回目からはありがとうポイント。デフォルトのキャラ・契約している人のアバター・協賛のAI棒 */
  async function onGacha(m) {
    if (!S.myRef) return send({ type: 'notice', why: 'gacha', detail: 'no ref' });
    const me = await getRef(S.myRef).catch(() => null) || {}, day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    if (m.peek) return send({ type: 'gacha', free: me.gachaDay !== day, pts: me.pts || 0, cost: GACHA.cost, col: (await loadCol(S.myRef, 'cards')).items || [] });
    const free = me.gachaDay !== day;
    if (!free && (me.pts || 0) < GACHA.cost) return send({ type: 'gacha', free, pts: me.pts || 0, cost: GACHA.cost, need: true, col: (await loadCol(S.myRef, 'cards')).items || [] });
    await putRef(S.myRef, free ? { gachaDay: day } : { pts: (me.pts || 0) - GACHA.cost });
    const r = Math.random(), users = r >= GACHA.rate.sponsor && r < GACHA.rate.sponsor + GACHA.rate.user ? await gachaUsers(S.myRef) : [];
    let card;
    if (r < GACHA.rate.sponsor && SPONSORS.length) { const sp = pickW(SPONSORS, x => x.weight || 1); card = { kind: 'sponsor', id: sp.id, name: sp.name, who: sp.who, catch: sp.catch, url: sp.url, color: sp.color || '#C9A24A', sample: !!sp.sample }; }
    else if (users.length) { const u = users[Math.floor(Math.random() * users.length)]; card = Object.assign({ kind: 'user', id: u.code }, cardOf(u.code, u), { lineId: '', insta: '' }); }
    else { const c = pickW(CHARS, x => ({ 1: 6, 2: 3, 3: 1 }[x.rare])); card = Object.assign({ kind: 'char' }, c); }
    const col = (await loadCol(S.myRef, 'cards')).items || [];
    const isNew = !col.some(x => x.id === card.id);
    if (isNew) col.unshift({ kind: card.kind, id: card.id, name: card.name, who: card.who || card.lineupName || '', color: card.color || '', avatar: card.avatar || '', at: Date.now() });
    await saveCol(S.myRef, 'cards', { items: col.slice(0, 200) });
    if (card.kind === 'user') card.friend = await isFriend(S.myRef, card.id), card.asked = (await friendsOf(S.myRef)).out.includes(card.id);
    send({ type: 'gacha', card, isNew, free: false, pts: free ? me.pts || 0 : (me.pts || 0) - GACHA.cost, cost: GACHA.cost, col: col.slice(0, 200) });
  }
  async function friendsView() {
    if (!S.myRef) return { type: 'friends', list: [], inbox: [], out: [], me: {} };
    const f = await friendsOf(S.myRef), me = await getRef(S.myRef).catch(() => null) || {};
    const card = async c => cardOf(c, await getRef(c).catch(() => null));
    return { type: 'friends', list: await Promise.all(f.list.slice(0, 100).map(card)), inbox: await Promise.all(f.inbox.slice(0, 50).map(card)), out: f.out,
      me: { gachaOn: me.gachaOn !== false, showLine: !!me.showLine, showInsta: !!me.showInsta, lineId: me.lineId || '', insta: me.insta || '', contract: funnelOf(me).stage === 'contract' } };
  }
  /** 友だち申請：ガチャで出た人に。相手が承認したら、アバターどうしで伝言・AI棒と話すができる */
  async function onFriend(m) {
    const other = String(m.code || '').replace(/[^\w-]/g, '').slice(0, 20);
    if (!S.myRef || !other || other === S.myRef) return send(await friendsView());
    const mine = await friendsOf(S.myRef), theirs = await friendsOf(other), who = S.me || 'ハタボの人';
    if (m.type === 'friend_req') {
      const col = (await loadCol(S.myRef, 'cards')).items || [];
      if (!col.some(x => x.id === other) || mine.list.includes(other) || mine.out.includes(other)) return send(await friendsView());   // ガチャで出た人にだけ
      if (theirs.out.includes(S.myRef)) { await saveCol(S.myRef, 'friends', { list: [...mine.list, other], out: mine.out.filter(x => x !== other), inbox: mine.inbox.filter(x => x !== other) }); await saveCol(other, 'friends', { list: [...theirs.list, S.myRef], out: theirs.out.filter(x => x !== S.myRef) }); }
      else { await saveCol(S.myRef, 'friends', { out: [...mine.out, other] }); await saveCol(other, 'friends', { inbox: [S.myRef, ...theirs.inbox.filter(x => x !== S.myRef)].slice(0, 50) }); postInbox(other, { kind: 'goen', from: S.myRef, fromName: who, text: who + 'さんから、AI棒の友だち申請がとどきました。マイハタボの「友だち」で承認できます。' }).catch(() => {}); }
    } else if (m.type === 'friend_ok' && mine.inbox.includes(other)) {
      await saveCol(S.myRef, 'friends', { list: [...new Set([...mine.list, other])], inbox: mine.inbox.filter(x => x !== other) });
      await saveCol(other, 'friends', { list: [...new Set([...theirs.list, S.myRef])], out: theirs.out.filter(x => x !== S.myRef) });
      postInbox(other, { kind: 'goen', from: S.myRef, fromName: who, text: who + 'さんが、友だち申請を承認しました。AI棒どうしで伝言や話ができます。' }).catch(() => {});
    } else if (m.type === 'friend_no') {
      await saveCol(S.myRef, 'friends', { inbox: mine.inbox.filter(x => x !== other) });
      await saveCol(other, 'friends', { out: theirs.out.filter(x => x !== S.myRef) });
    } else if (m.type === 'friend_del') {
      await saveCol(S.myRef, 'friends', { list: mine.list.filter(x => x !== other) });
      await saveCol(other, 'friends', { list: theirs.list.filter(x => x !== S.myRef) });
    }
    send(await friendsView());
  }
  /** お試しの申し込み・プランの変更・お試しをやめる・契約。ヒロさんに案件メモで知らせる */
  async function onFunnel(m) {
    if (!S.myRef) return send({ type: 'notice', why: 'funnel', detail: 'no ref' });
    const act = String(m.act || ''), L = LINEUP[m.lineup], g = String(m.grade || ''), pay = m.pay === 'y' ? 'y' : 'm';
    const r = await getRef(S.myRef).catch(() => null) || {}, cur = funnelOf(r), now = Date.now();
    let patch = null, kind = '';
    if ((act === 'trial' || act === 'change' || act === 'contract') && !(L && L.grades[g])) return send({ type: 'notice', why: 'funnel', detail: 'plan' });
    if (act === 'trial' && !cur.stage) { patch = { stage: 'trial', lineup: m.lineup, grade: g, pay, trialAt: now, trialUntil: now + TRIAL_DAYS * 86400000 }; kind = 'お試しの申し込み'; }
    else if (act === 'change' && (cur.stage === 'trial' || cur.stage === 'contract')) { patch = { lineup: m.lineup, grade: g, pay }; kind = 'プランの変更'; }
    else if (act === 'cancel' && cur.stage === 'trial') { patch = { stage: 'cancel', cancelAt: now }; kind = 'お試しをやめる'; }
    else if (act === 'contract' && (cur.stage === 'cancel' || !cur.stage)) { patch = { stage: 'contract', lineup: m.lineup, grade: g, pay, contractAt: now }; kind = '契約の申し込み'; }
    if (!patch) return send(await myPage(S));
    if (cur.stage === 'trial' && Date.now() > (r.trialUntil || 0)) patch.stage = patch.stage || 'contract';
    await putRef(S.myRef, patch);
    S.funnel = funnelOf(Object.assign({}, r, patch));
    const f = S.funnel, title = kind + '：' + (f.lineupName || '') + ' ' + (f.grade || '') + (f.price ? '（' + f.price + (f.pay === 'y' ? '・年払い' : '・月払い') + '）' : '');
    console.log('funnel', JSON.stringify({ owner: S.owner, name: S.me, act, lineup: f.lineup, grade: f.grade, pay: f.pay }));
    gas(Object.assign({ action: 'lead', lead: { who: S.me, ref: await refLabel(S.refFrom || S.ref || ''), kind: '契約', title, need: kind, when: f.stage === 'trial' ? new Date(f.trialUntil).toLocaleDateString('ja-JP') + 'までお試し' : '', budget: f.price || '', next: act === 'cancel' ? 'お試しをやめた理由を聞く' : 'お支払いの登録を案内する', memo: '' } }, S.auth)).catch(() => {});
    if (act === 'trial') tellUpline(S, 'お試し（' + (f.lineupName || '') + '）をはじめました', 'trial').catch(() => {});
    if (act === 'contract') { tellUpline(S, (f.lineupName || '') + ' ' + (f.grade || '') + 'を契約しました', 'contract').catch(() => {}); putRef(S.myRef, { thanked: true }).catch(() => {}); }
    send(await myPage(S));
    const say = { trial: '10日間のお試しがはじまったボー！いちばん上のZで動くから、なんでも頼んでほしいボー。', change: 'プランを変えたボー。', cancel: 'お試しをやめたボー。また話したくなったら、いつでも呼んでほしいボー。', contract: 'お申し込みありがとうだボー！お支払いの案内は、ハタラボから届くボー。' }[act];
    if (say) speakOnly(S.avatar === 'komugi' ? say.replace(/だボー/g, 'です').replace(/ボー/g, 'です') : S.avatar === 'hatabo' ? say : say.replace(/だボー/g, 'だぜ').replace(/ボー/g, 'ぜ'), act === 'cancel' ? 'shy' : 'excited');
  }
  /** 伝言：「〇〇さんに、△△って伝えて」。ご縁でつながった人のハタボに届ける */
  async function dengon(text) {
    const people = await goenPeople(S.myRef).catch(() => []);
    const hit = people.filter(p => p.name && text.indexOf(String(p.name).replace(/さん$/, '')) >= 0).sort((a, b) => b.name.length - a.name.length)[0];
    const T = S.avatar === 'komugi' ? x => x.replace(/ボー/g, 'です') : S.avatar === 'hatabo' ? x => x : x => x.replace(/だボー/g, 'だぜ').replace(/ボー/g, 'ぜ');
    if (!hit) return false;   // ご縁の人の名前がない（「ヒロさんに伝えて」など）は、いつもの返事へ
    const i = text.indexOf(String(hit.name).replace(/さん$/, ''));
    let body = text.slice(i + String(hit.name).replace(/さん$/, '').length).replace(/^(さん|くん|ちゃん|様|さま)?(に|へ)[、,\s]*/, '').replace(/(って|と)?(伝えて|つたえて|伝言して|でんごんして|言っといて|いっといて|送っといて|おくっといて)[。！!]*\s*$/, '').trim();
    if (body.length < 2) { speakOnly(T(hit.name + 'さんに、なんて伝えるボー？'), 'think'); return true; }
    await postInbox(hit.code, { kind: 'msg', from: S.myRef, fromName: S.me || 'ご縁の人', text: body });
    send({ type: 'note_saved', kind: 'dengon' });
    speakOnly(T(hit.name + 'さんのAI棒に、伝言をとどけたボー。'), 'smile');
    return true;
  }
  /** 開いたときに、まだ読んでいない伝言を伝える */
  async function deliverInbox() {
    if (!S.myRef) return;
    const items = await loadInbox(S.myRef).catch(() => []), un = items.filter(x => !x.read);
    if (!un.length) return;
    const T = S.avatar === 'komugi' ? x => x.replace(/だボー/g, 'です').replace(/ボー/g, 'です') : S.avatar === 'hatabo' ? x => x : x => x.replace(/だボー/g, 'だぜ').replace(/ボー/g, 'ぜ');
    const lines = un.slice(0, 3).map(x => x.kind === 'goen' ? x.text : x.fromName + 'さんから：「' + String(x.text).slice(0, 120) + '」');
    await speakOnly(T('伝言が' + un.length + '件あるボー。' + lines.join('　') + (un.length > 3 ? '　ほかはマイハタボの伝言で見られるボー。' : '')), 'excited');
    items.forEach(x => { x.read = true; }); await saveInbox(S.myRef, items);
  }
  /** メモ：「〇〇をメモして」。中身がなければ、さっきの返事をメモする */
  async function memo(text) {
    let body = String(text).replace(MEMO_RE, '').replace(/^(ハタボ|コムギ|ジュニア)[、,\s]*/, '').replace(/(を|って|と)?[、。！!\s]*$/, '').trim();
    if (body.replace(/(いまの|今の|さっきの|それ|これ)/g, '').length < 4) { const last = [...S.history].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string'); body = last ? last.content : ''; }
    if (!body) return speakOnly('まだメモすることがないみたい。メモしたいことを言ってね。', 'shy');
    try {
      await addNote(S.owner, { kind: 'memo', title: body.replace(/\s+/g, ' ').slice(0, 30), text: body });
      send({ type: 'note_saved', kind: 'memo' });
      speakOnly(S.avatar === 'komugi' ? 'メモしときました。マイハタボの「メモ・議事録」で見れるとです。' : S.avatar === 'hatabo' ? 'メモしたボー。マイハタボの「メモ・議事録」で見られるボー。' : 'がってん、メモしといたぜ。マイハタボの「メモ・議事録」で見られるぜ。', 'smile');
    } catch (e) { speakOnly('ごめん、メモがうまく残せなかった。', 'sad'); }
  }
  /** 議事録：いままでの話をまとめて、GASでPDFにしてドライブへ。リンクを吹き出しに出す */
  async function minutes(pdf) {
    speakOnly(pdf ? 'がってん、議事録をまとめてPDFにするぜ。ちょいと待ってくんな。' : 'がってん、議事録をまとめとくぜ。ちょいと待ってくんな。', 'think');
    const talk = S.history.slice(-24).map(m => (m.role === 'user' ? (S.me || 'みんな') : 'ジュニア') + '：' + (typeof m.content === 'string' ? m.content : '（写真）')).join('\n')
      + (S.asideLog.length ? '\n（まわりで聞こえた会話）\n' + S.asideLog.join('\n') : '');
    if (!talk.trim()) return speakOnly('まだまとめる話がねぇんだ。もうちょい話してからにしようぜ。', 'shy');
    try {
      const d = new Date(Date.now() + 9 * 3600000), day = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
      const r = await deps.claude.messages.create({
        model: ENV.SMART_MODEL, max_tokens: 1500,
        system: 'あなたは議事録係。会話にあったことだけを、ていねいな日本語でまとめる。想像で足さない。住所・電話番号・お金や体調のくわしいことは書かない。',
        messages: [{ role: 'user', content: '次の会話を議事録にして。形式：1行目にタイトル（20字以内）。そのあと見出し「日時」「参加」「話したこと」「決まったこと」「つぎにやること（だれが・いつまでに）」を、それぞれ短い箇条書きで。日時は ' + day + '。\n\n' + talk }],
      });
      const t = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      const title = (t.split('\n')[0] || '議事録').replace(/^#+\s*/, '').slice(0, 40);
      await addNote(S.owner, { kind: 'minutes', title: day + ' ' + title, text: t }).catch(() => {});
      if (S.guest) { send({ type: 'note_saved', kind: 'minutes' }); return speakOnly(S.avatar === 'komugi' ? '議事録、マイハタボの「メモ・議事録」に残したとです。' : '議事録をまとめて、マイハタボの「メモ・議事録」に残したボー！', 'excited'); }
      const g = await gas(Object.assign({ action: 'minutes', mode: S.mode, pdf: !!pdf, title: day + ' ' + title, text: t }, S.auth));
      if (!g || !g.ok || !g.url) throw new Error((g && (g.detail || g.error)) || 'minutes');
      send({ type: 'links', links: [{ title: (pdf ? '議事録（PDF）：' : '議事録：') + title, url: g.url }] });
      S.brainAt = 0;      // つぎの返事から、議事録も読んだ記録で話す
      speakOnly(pdf ? '議事録のPDFができたぜ！吹き出しのリンクから開いてくんな。' : '議事録を残しといたぜ！お兄さん分のバターちゃんも読めるから、続きはどっちでも話せるぜ。', 'excited');
    } catch (e) { console.error('minutes', String(e.message).slice(0, 200)); speakOnly('すまねぇ、議事録がうまく作れなかったぜ。', 'sad'); }
  }
  /** メール：ヒロさんだけ。未読をGASから読んで、短く知らせる（記録には残さない） */
  async function mailNote() {
    if (S.guest || S.asGuest || S.mode !== 'family') return null;   // 本人かどうかは GAS がLINEのIDで確かめる
    try { const g = await gas(Object.assign({ action: 'mail' }, S.auth)); return g && g.ok ? g.mails || [] : null; } catch (e) { return null; }
  }
  async function setTrio(on) {
    if (S.guest) return;
    S.trio = on; S.aside = [];
    send({ type: 'trio', on, waitMs: S.waitMs });
    savePrefs(S.owner, { trio: on });
    return speakOnly(on ? 'おう、三人モードにするぜ。おいらに話すときは「ジュニア」って呼んでくんな。' : 'ふつうのモードにもどすぜ。', 'excited');
  }
  function greetFor() {
    if (S.avatar !== 'hatabo') return AVS[S.avatar].greet(S.me);
    const cm = S.custom && S.custom.callMe;
    if (!cm) S.askName = true;
    return hataboHello(cm, S.role === 'サービス相談', S.me);
  }
  /** 「なんて呼べばいい？」への答えから呼び名を取り出す（〜でいいよ・〜って呼んで・〜です） */
  function pickCallName(t) {
    let x = String(t || '').replace(/[。、！!？?\s]/g, '').replace(/^(ぼくは|ぼくの名前は|わたしは|私は|俺は|おれは|うちは|名前は|なまえは)/, '');
    x = x.replace(/(って|と)?(呼んで|よんで)(ください|ほしい|ね|よ)?$/, '').replace(/(で|が)?(いい|良い|OK|おっけー|オッケー)(です|よ|かな|な)?$/, '').replace(/(です|だよ|でーす|っす|と申します|といいます|と言います|でお願いします|でおねがいします)$/, '');
    return x.length >= 1 && x.length <= 12 ? x : '';
  }
  async function onHeard(text) {
    if (S.avatar === 'hatabo' || S.avatar === 'komugi' || S.app === 'hatabo') text = hearFix(text);
    S.lastPartial = Date.now(); S.utt++;
    if (S.askName && S.avatar === 'hatabo' && !S.visit) {
      S.askName = false;
      const yes = /^(うん|はい|いいよ|それで(いい|OK)|OK|オッケー|おっけー|大丈夫|だいじょうぶ|そう)[。！!、\s]*(だよ|です|よ)?[。！!]*$/i.test(String(text).trim());
      const nm = yes && S.me ? S.me + 'さん' : pickCallName(text);
      if (nm && S.owner) {
        S.custom = Object.assign(cleanCustom(S.custom || {}), { callMe: nm }); savePrefs(S.owner, { custom: S.custom }).catch(() => {});
        return speakOnly(nm + '、だね。覚えたボー！' + (S.role === 'サービス相談' ? 'ハタボのことで、知りたいことはあるボー？' : 'それで、' + nm + 'がいま困っていることや、うまくいかなくてモヤモヤしていることはあるボー？'), 'excited');
      }
    }
    // 声での切りかえ：三人モード中は「ジュニア、ふたりモードにして」のように呼ばれたときだけ。すでに同じモードなら何もしない
    if (TRIO_ON.test(text) && !S.trio) return setTrio(true);
    if (TRIO_OFF.test(text) && S.trio && calledJunior(text)) return setTrio(false);
    if (S.trio && (TRIO_ON.test(text) || TRIO_OFF.test(text)) && !calledJunior(text)) { S.aside.push(text.slice(0, 200)); if (S.aside.length > 8) S.aside.shift(); return; }
    if (S.trio) {
      // ジュニアが質問したすぐあと（12びょう以内）の1回だけは、名前がなくても答えの続きとして受けとる
      const follow = Date.now() < (S.followUntil || 0) && !/^(バターちゃん|ばたーちゃん)/.test(text);
      S.followUntil = 0;
      if (!calledJunior(text) && !calledJam(text) && !follow) {                     // 呼ばれていない：聞いておくだけ（あとで話の流れに使う）
        S.aside.push(text.slice(0, 200)); if (S.aside.length > 8) S.aside.shift();
        S.asideLog.push(text.slice(0, 200)); if (S.asideLog.length > 30) S.asideLog.shift();
        return;
      }
      if (PACE_SLOW.test(text) || PACE_FAST.test(text)) {
        S.waitMs = Math.max(0, Math.min(3000, S.waitMs + (PACE_SLOW.test(text) ? 600 : -600)));
        savePrefs(S.owner, { waitMs: S.waitMs }); send({ type: 'trio', on: true, waitMs: S.waitMs });
        return speakOnly(PACE_SLOW.test(text) ? 'がってんだ、次からもう少し待ってから話すぜ。' : 'がってんだ、次からすぐ答えるぜ。', 'smile');
      }
    }
    if ((!S.guest || S.asGuest) && LEARN_RE.test(text)) return learn(text);
    if ((!S.guest || S.asGuest) && FORGET_RE.test(text)) { S.lessons = []; S.learned = []; savePrefs(S.asGuest ? GUEST_COMMON : S.owner, { lessons: [], learned: [] }); return speakOnly('がってんだ、教わったことはきれいさっぱり忘れたぜ。', 'smile'); }
    if (MINUTES_RE.test(text)) return minutes(PDF_RE.test(text) && !S.guest);
    if (MEMO_RE.test(text)) return memo(text);
    if (S.myRef && DENGON_RE.test(text) && await dengon(text)) return;
    if (calledJunior(text) && nameOnly(text)) return speakOnly(AVS[S.avatar] ? AVS[S.avatar].quick : QUICK[Math.floor(Math.random() * QUICK.length)], 'smile');
    if (KAKEGOE_RE.test(text)) return speakOnly(S.guest || S.mode === 'business' ? KAKEGOE_GUEST : KAKEGOE_FAMILY, 'excited');
    if (QUIET_RE.test(text)) { S.quiet = true; send({ type: 'quiet', on: true }); return speakOnly('おう、しずかにしてるぜ。用があったら名前を呼んでくんな。', 'smile'); }
    if (S.quiet) { if (!(S.trio ? (calledJunior(text) || calledJam(text)) : /(バター|ばたー|ジュニア|ジャム)/.test(text))) return; S.quiet = false; send({ type: 'quiet', on: false }); }
    if (VOLUME_UP.test(text)) { send({ type: 'volume', delta: +0.25 }); return speakOnly('このくらいでどうかな？', 'smile'); }
    if (VOLUME_DOWN.test(text)) { send({ type: 'volume', delta: -0.25 }); return speakOnly('このくらいでどうかな？', 'smile'); }
    if (VIDEO_RE.test(text)) { send({ type: 'camera', kind: 'video', prompt: text }); return speakOnly('動画を撮るね。10びょうだよ、よーい、スタート！', 'excited'); }
    if (PHOTO_RE.test(text)) { S.pendingPhoto = text; send({ type: 'camera', kind: 'photo', prompt: text }); return; }
    let said = text;
    if (S.trio && S.aside.length) {
      said = '【まわりで聞こえた会話（だれが言ったかはわからない）】\n' + S.aside.join('\n') + '\n\n【ジュニアへの呼びかけ】\n' + text;
      S.aside = [];
    }
    reply([{ type: 'text', text: said }], text, calledJam(text) && !calledJunior(text) ? 'jam' : '');
  }
  /** 三人モード：まわりが静かになるまで少し待ってから話しはじめる */
  async function waitQuiet(gen, utt) {
    if (!S.trio) return;
    // まわり（Claudeアプリのバターちゃんなど）が話しているあいだは待つ。8びょう待っても静かにならなければ話す
    const t0 = Date.now();
    let told = false;
    while (gen === S.gen && Date.now() - S.lastPartial < S.waitMs && Date.now() - t0 < 8000) {
      if (!told && Date.now() - t0 > 600) { told = true; send({ type: 'waiting', gen }); }
      await new Promise(r => setTimeout(r, 120));
    }
  }

  /* --- 返事：Claudeを流しながら、一文ずつ読み上げて送る --- */
  function stopReply(why) {
    S.gen++;
    if (S.aborter) { try { S.aborter.abort(); } catch (e) {} S.aborter = null; }
    if (S.speaking) send({ type: 'stopped', why });
    S.speaking = false;
  }
  async function speakOnly(text, emotion, as, nobubble) {
    if (typeof text === 'string') text = text.replace(/〈伝え先〉/g, S.tellTo || 'ハタボの事務局');
    stopReply('new');
    const gen = S.gen; S.speaking = true;
    send({ type: 'reply_start', gen, emotion, as: as || 'ジュニア', nobubble: !!nobubble });
    try { send({ type: 'audio', gen, seq: 0, text, mp3: await synth(text, S.voice) }); } catch (e) { send({ type: 'notice', why: 'tts', detail: String(e.message).slice(0, 80) }); }
    if (gen === S.gen) { send({ type: 'reply_end', gen, emotion, text }); S.speaking = false; }
  }
  async function reply(content, logText, as) {
    const jam = as === 'jam';
    const voice = jam ? JAM_VOICE : S.voice;
    if (!S.asGuest && !superUntil(S.owner) && !quotaOk(S.owner || 'anon', S.guest && !S.claude, !!S.refFrom, gradeCap(S)) && !(await useTicket())) { send({ type: 'limit', why: 'plan' }); return speakOnly(S.avatar === 'hatabo' ? 'きょう話せる回数がいっぱいになったボー。チケットを足すと、このまま続けられるボー。' : S.avatar === 'komugi' ? 'きょう話せる回数がいっぱいになったとです。チケットを足すと、このまま続けられますよ。' : S.guest ? 'すまねぇ、きょうここで話せる回数がいっぱいになっちまった。続きはヒロさんに伝えとくから、また明日話そうぜ！' : 'きょうの回数がいっぱいになっちまった。また明日話そうぜ！', 'shy'); }
    bumpStats(S);
    if (!S.asGuest && S.funnel && S.funnel.stage === 'trial' && (counts.get((S.owner || 'anon') + ':' + new Date().toISOString().slice(0, 10)) || 0) > TRIAL_DAILY && !(await useTicket()) && (send({ type: 'limit', why: 'trial' }) || true))
      return speakOnly(S.avatar === 'komugi' ? 'お試しは1日' + TRIAL_DAILY + '回までなんです。また明日、話しましょう。' : 'お試しのZは1日' + TRIAL_DAILY + '回までだボー。また明日話そうボー。', 'shy');
    if (Date.now() - (S.brainAt || 0) > 10 * 60 * 1000) { try { await loadBrain(true); } catch (e) {} }   // 記録は10分ごとに読みなおす
    let noRecord = false;
    if (MAIL_RE.test(logText || '')) {
      const mails = await mailNote();
      if (mails) {
        noRecord = true;          // メールの中身は、会話の記録・日記に残さない
        const box = mails.length ? mails.map((x, i) => (i + 1) + '. ' + x.from + '「' + x.subject + '」' + (x.snippet ? '：' + x.snippet : '')).join('\n') : '（未読のメールはない）';
        content = [{ type: 'text', text: '【ヒロさんの受信トレイの未読（新しい順・最大5通）。ヒロさんにだけ短く伝える】\n' + box + '\n\n【ヒロさんの言葉】\n' + logText }];
      } else {
        return speakOnly('すまねぇ、メールはヒロさんにしか見せられねぇんだ。', 'shy');
      }
    }
    stopReply('new');
    const gen = S.gen, utt0 = S.utt; S.speaking = true;
    const ac = new AbortController(); S.aborter = ac;
    const plan = planOf(S);
    let msgs = cleanTurns(S.history).slice(-plan.turns).concat([{ role: 'user', content }]);
    const use = { model: '', inTok: 0, outTok: 0, cacheTok: 0, searches: 0 };
    let full = '', emotion = 'smile', head = true, seq = 0, chain = Promise.resolve();
    send({ type: 'reply_start', gen, as: jam ? 'ジャム猫' : !S.visit && S.custom && S.custom.aiName ? S.custom.aiName : AVS[S.avatar] ? AVS[S.avatar].name : 'ジュニア' });
    if (S.placeP) { await S.placeP.catch(() => {}); S.placeP = null; }
    const study = !jam && !S.guest && S.mode === 'family' && STUDY_RE.test(logText || '');
    const route = jam ? { smart: false, search: false } : needSmart(logText, S.guest);
    if (study) route.smart = true;                  // 勉強は賢いモデルで、ていねいに
    const claudeMode = !!(plan === PLANS.super && !jam && !S.trio && !S.visit);   // Z（スーパー上位）は、だれでもClaudeと同じ精度で答える
    const longMode = !!(plan.long && !jam && !S.trio && S.role !== 'サービス相談' && (claudeMode || LONG_RE.test(logText || '')));
    const maxSent = (S.trio ? 2 : study ? 5 : route.search ? 4 : 3) + (S.trio ? 0 : plan.extraSent) + (S.firstDay && S.avatar === 'hatabo' ? 3 : 0);   // 初日は、サービスの説明ができるように声も長めに
    let capped = false, spoken = '';
    const sp = splitter(sentence => {
      const s = clean(sentence).trim();
      if (!s || capped) return;
      if (seq >= maxSent) { capped = true; return; }      // 三人モードは2文まで
      spoken += s;
      const n = seq++;
      const p = synth(s, voice).catch(() => jam ? synth(s, S.voice) : Promise.reject(new Error('tts'))).catch(e => { send({ type: 'notice', why: 'tts', detail: String(e.message).slice(0, 80) }); return ''; });
      chain = chain.then(async () => { const mp3 = await p; if (n === 0) await waitQuiet(gen, utt0); if (gen === S.gen && mp3) send({ type: 'audio', gen, seq: n, text: s, mp3 }); });
    });
    let lastErr = '';
    const links = [], seenUrl = new Set();
    const addLink = (url, title, cited) => { if (!url || seenUrl.has(url)) return; seenUrl.add(url); links[cited ? 'unshift' : 'push']({ url: String(url).slice(0, 500), title: String(title || url).slice(0, 80) }); };
    if (route.search) msgs = msgs.slice(-6);      // 調べるときは、最近の話だけ（速く・確かに）
    let pauses = 0, cut = false;
    for (let attempt = 0; attempt < 3; attempt++) {
    let stopReason = '';
    try {
      // 2回目は、それまでの会話をつけずに聞く（会話の記録がこわれていても答えられるように）
      // 1回目：必要なら賢いモデル＋検索。だめなら2回目は速いモデルだけ（検索なし・会話の記録なし）
      // 1回目：必要なら賢いモデル＋検索（場所つき）。2回目：検索だけもう一度（場所の設定なし）。3回目：速いモデルだけ
      const useSmart = route.smart && attempt < 2, useSearch = route.search && attempt < 2 && ENV.WEB_SEARCH;
      const params = {
        model: plan.premium && attempt < 2 && !jam ? ENV.PREMIUM_MODEL : (useSmart || (plan.smart && attempt < 2 && !jam)) ? ENV.SMART_MODEL : ENV.MODEL,
        max_tokens: (S.trio ? 240 : study ? 520 : S.mode === 'business' ? 340 : 320) + (useSearch ? 400 : 0) + (S.trio ? 0 : plan.extraTokens) + (longMode ? 3500 : 0) + (S.firstDay && S.avatar === 'hatabo' ? 400 : 0),
        system: sysBlocks((claudeMode && !LONG_RE.test(logText || '') ? CLAUDE_RULE : longMode ? LONG_RULE : plan === PLANS.high && !jam && !S.trio ? HIGH_RULE : '') + (study ? STUDY_RULE : '') + (jam ? JAM_RULE : '') + (route.search && !useSearch ? '\n\n【いまは調べられない】検索が使えないので、今の情報は「おいらには調べられねぇんだ」と正直に言う。' : '')),
        messages: attempt === 2 || (attempt === 1 && !useSearch) ? [{ role: 'user', content }] : msgs,
      };
      if (useSearch) {
        // 場所は英字の決まった形だけ渡す（日本語の地名を入れると失敗することがあるので、くわしい地名はシステムの文に書く）
        params.tools = [Object.assign({ type: 'web_search_20250305', name: 'web_search', max_uses: plan.maxUses },
          attempt === 0 && !S.guest ? { user_location: { type: 'approximate', city: 'Kawasaki', region: 'Kanagawa', country: 'JP', timezone: 'Asia/Tokyo' } } : {})];
        if (attempt === 0) send({ type: 'searching', gen });
      }
      const stream = deps.claude.messages.stream(params, { signal: ac.signal });
      use.model = params.model;
      for await (const ev of stream) {
        if (gen !== S.gen) break;
        // 使った量（プランのくらべ用）：入力・出力・キャッシュのトークンと検索の回数
        if (ev.type === 'message_start' && ev.message && ev.message.usage) { const u = ev.message.usage; use.inTok += u.input_tokens || 0; use.cacheTok += (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); }
        if (ev.type === 'message_delta' && ev.usage) { use.outTok += ev.usage.output_tokens || 0; const st = ev.usage.server_tool_use; if (st && st.web_search_requests) use.searches += st.web_search_requests; }
        // 調べた先のページ：引用されたものを先に、なければ検索結果の上から
        if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'web_search_tool_result' && Array.isArray(ev.content_block.content)) ev.content_block.content.slice(0, 3).forEach(x => addLink(x.url, x.title, false));
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'citations_delta' && ev.delta.citation) addLink(ev.delta.citation.url, ev.delta.citation.title, true);
        if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.type !== 'content_block_delta' || !ev.delta || ev.delta.type !== 'text_delta') continue;
        let t = ev.delta.text;
        full += t;
        if (head) {                                   // 先頭の [わくわく] を気持ちにして、読み上げない
          const probe = full.trimStart();
          if (/^[\[［]/.test(probe) && !/[\]］]/.test(probe)) continue;
          const e = takeEmotion(probe);
          if (e) { emotion = e.emotion; t = e.rest; send({ type: 'emotion', gen, emotion }); } else t = probe;
          head = false;
        }
        if (capped && !longMode) { try { ac.abort(); } catch (e) {} break; }   // 長文のときは、声は止めても吹き出しには最後まで出す
        send({ type: 'reply_text', gen, text: t });
        sp.push(t);
      }
      // 調べものが長いと、AIがいったん区切って返す（pause_turn）。そのときは続きをもらう（2回まで）
      if (stopReason === 'pause_turn' && pauses < 2 && gen === S.gen && !capped && typeof stream.finalMessage === 'function') {
        const fm = await stream.finalMessage();
        msgs = msgs.concat([{ role: 'assistant', content: fm.content }]);
        pauses++; attempt--; continue;
      }
      // 返事が空っぽ：もう一度（2回目は場所なしの検索、3回目は速いモデルだけ）
      if (!clean(full).trim() && gen === S.gen && !capped) {
        console.error('empty reply', attempt, stopReason || '-');
        if (attempt < 2) { lastErr = 'empty ' + (stopReason || '-'); continue; }
        send({ type: 'notice', why: 'empty', detail: stopReason || '-' });
      }
      if (stopReason === 'max_tokens') { sp.drop(); cut = true; } else sp.end();   // 上限で切れたときは、とちゅうの文を読まない
      await chain;
      break;
    } catch (e) {
      if (capped || gen !== S.gen) break;
      lastErr = String(e.message || e);
      console.error('ai error', attempt, lastErr.slice(0, 300));
      // 賢いモデルや検索がこのキーで使えないときは、次からは使わない（毎回失敗しないように）
      if (route.search && /(not enabled|not allowed|disabled|permission)/i.test(lastErr) && /web/i.test(lastErr)) { ENV.WEB_SEARCH = false; console.error('web search off'); }
      if (attempt === 0 && route.smart && /model/i.test(lastErr) && /not_found|invalid|does not exist/i.test(lastErr)) { ENV.SMART_MODEL = ENV.MODEL; console.error('smart model off'); }
      if (attempt === 0 && plan.premium && /model/i.test(lastErr) && /not_found|invalid|does not exist/i.test(lastErr)) { ENV.PREMIUM_MODEL = ENV.SMART_MODEL; console.error('premium model off'); }
      if (full || attempt === 2) { send({ type: 'notice', why: 'ai', detail: lastErr.slice(0, 120) }); break; }
      await new Promise(r => setTimeout(r, 400));
    }
    }
    if (gen !== S.gen) return;
    let text = capped && !longMode ? spoken : clean(full).trim();
    if (cut && !capped) { const k = Math.max(text.lastIndexOf('。'), text.lastIndexOf('！'), text.lastIndexOf('？'), text.lastIndexOf('!'), text.lastIndexOf('?')); if (k > 0) text = text.slice(0, k + 1); }
    if (text && !noRecord) S.history.push({ role: 'user', content: logText || '（写真を見せた）' }, { role: 'assistant', content: text });
    if (S.visit && logText) S.visitLog.push(String(logText).slice(0, 200));
    if (links.length && text) send({ type: 'links', gen, links: links.slice(0, 3) });
    if (longMode && text && text.length > 200 && S.owner) addNote(S.owner, { kind: 'doc', title: (logText || '書いた文章').replace(/\s+/g, ' ').slice(0, 30), text }).then(() => send({ type: 'note_saved', kind: 'doc' })).catch(() => {});
    if (S.trio && /[？?]\s*$/.test(text)) S.followUntil = Date.now() + 12000;   // ジュニアが質問した → つぎの1回は名前なしでも   // 空の返事は記録しない（次の会話がこわれるので）
    if (S.history.length > plan.keep) S.history = S.history.slice(-plan.keep);
    // 人ごとのAI代（獲得コストを後で出すため）：LINEのIDの紹介コードに足していく（円・1ドル150円）
    { const P = /opus/.test(use.model) ? [4, 20, 0.2] : /sonnet/.test(use.model) ? [2, 10, 0.1] : /haiku-5/.test(use.model) ? [0.1, 0.5, 0.01] : [1, 5, 0.1];
      const yen = ((use.inTok * P[0] + use.outTok * P[1] + use.cacheTok * P[2]) / 1e6 + use.searches * 0.01) * 150 + (spoken.length || 0) * 0.0045 + 0.4;
      if (S.myRef) { S.costYen = (S.costYen || 0) + yen; putRef(S.myRef, { costYen: Math.round(S.costYen * 10) / 10, costAt: Date.now() }).catch(() => {}); } }
    const usage = plan === PLANS.std && !S.plan ? undefined : { plan: plan.label, model: use.model, in: use.inTok, out: use.outTok, cache: use.cacheTok, searches: use.searches };
    if (usage) console.log('plan usage', JSON.stringify(usage));
    send({ type: 'reply_end', gen, emotion, text, why: text ? undefined : lastErr.slice(0, 120), usage });
    S.speaking = false; S.aborter = null;
    if (S.mode === 'family' && logText && !noRecord) gas(Object.assign({ action: 'log', said: logText, reply: text }, S.auth)).catch(() => {});
    if (convoKey() && text && !noRecord) {
      S.newTurns++;
      saveConvo(convoKey(), { turns: S.history.slice(-12), newTurns: S.newTurns, at: Date.now() });
      if (S.newTurns >= 6 || (S.guest && TELL_RE.test(logText || '') && S.newTurns >= 2)) summarize();
    }
  }

  /* --- 写真：言われたときだけ。保存しない --- */
  function onPhoto(m) {
    const data = String(m.data || '').replace(/^data:image\/\w+;base64,/, '');
    if (!data || data.length > 4 * 1024 * 1024) return speakOnly('うまく写真が届かなかったよ。もう一回撮ってね。', 'sad');
    const prompt = String(m.prompt || S.pendingPhoto || 'これ見て').slice(0, 200);
    S.pendingPhoto = '';
    const imgs = (Array.isArray(m.frames) ? m.frames : [data]).slice(0, 4).map(d => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: String(d).replace(/^data:image\/\w+;base64,/, '') } }));
    reply(imgs.concat([{ type: 'text', text: prompt + (m.frames ? '（動画から切り出した数枚）' : '') + '　見えたものについて、短く話して。' }]), prompt + '（写真）');
  }

  /* --- ご縁つなぎ --- */
  async function onProfile(m) {
    if (!S.owner) return send({ type: 'goen_error', why: 'owner' });
    const p = await saveProfile(S.owner, Object.assign({ name: S.me }, m.profile || {}));
    send({ type: 'profile', profile: p });
  }
  async function onGoen(m) {
    try {
      const mine = await loadProfile(S.owner);
      if (!mine) return send({ type: 'goen_error', why: 'no_profile' });
      const other = await findByCode(m.code);
      if (!other) return send({ type: 'goen_error', why: 'no_code' });
      if (other.owner === mine.owner) return send({ type: 'goen_error', why: 'self' });
      send({ type: 'goen_wait' });
      const g = await goenTalk(mine, other);
      await addGoen(mine, other, g);
      send({ type: 'goen_result', with: other.character, lines: g.lines, match: g.match, next: g.next, goen: (mine.goen || 0) + 1 });
      speakOnly(`${other.character}と話してきたよ！${g.match}${g.next}`, 'excited');
    } catch (e) { send({ type: 'goen_error', why: 'ai', detail: String(e.message).slice(0, 80) }); }
  }

  /* --- うけとり --- */
  ws.on('message', async (raw, isBinary) => {
    if (isBinary) return onAudio(raw);
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    try {
      if (m.type === 'hello') {
        S.mode = m.mode === 'business' ? 'business' : 'family';
        S.voice = /^ja-JP-[\w-]+$/.test(m.voice || '') ? m.voice : '';
        S.auth = m.idToken ? { idToken: String(m.idToken) } : { pass: String(m.pass || '') };
        S.ref = String(m.ref || '').replace(/[^\w-]/g, '').slice(0, 20);
        S.agent = m.agent === 'service' ? 'service' : '';
        S.visit = String(m.visit || '').replace(/[^\w-]/g, '').slice(0, 20);   // ご縁の図から、その人のAI棒と話す   // 公式LINEのリッチメニューの「ハタボに相談」：サイトと同じサービス相談
        S.asGuest = !!m.asGuest;
        S.peek = !!m.peek;               // 見るだけ（&test=peek）：紹介のつながり・アバターの記録を変えない          // 家族が「窓口の画面」を試すとき（&test=guest）
        try { await loadBrain(); } catch (e) {
          if (e.code === 'auth' || e.code === 'pass') return fail('auth', String(e.message).slice(0, 80));
          if (e.code === 'closed') return fail('closed', 'いま窓口はお休み中');
          // GASが読めないときも切らずに話す（家族の記録なし）。三人モードなどはページから受けとる
          S.system = MIN_PERSONA + SELF; S.brainAt = Date.now() - 9 * 60 * 1000;
          send({ type: 'notice', why: 'brain', detail: 'GASが読めないので、記録なしで話しています' });
        }
        // ハタボのミニアプリで家族（ヒロさん）が開いたとき：中身は家族のまま、声と話し方はハタボ
        if (m.app === 'hatabo' && !S.guest) {
          S.avatar = 'hatabo'; S.voice = AVS.hatabo.voice();
          S.system += '\n\n【いまの話し方】ここはハタボのミニアプリ。あなたの名前はハタボ（愛称ハタボー）。一人称は「ぼく」、語尾に「〜ボー」をつける。江戸っ子の話し方（てやんでぃ・がってん・〜だぜ）はしない。';
        }
        S.ready = true;
        // 紹介コード：自分のコードを作り、はじめて来た人は「だれの紹介か」を覚える
        S.myRef = S.owner ? myRefOf(S.owner) : '';
        if (S.myRef && !S.peek) {
          const mine = await getRef(S.myRef);
          const parent = mine && mine.parent ? mine.parent : (S.ref && S.ref !== S.myRef ? S.ref : '');
          S.refFrom = parent;
          await putRef(S.myRef, { owner: S.owner, name: S.me || (mine && mine.name) || '', parent, at: (mine && mine.at) || Date.now() });
          // 初めて来た人なら、紹介した人の「ご縁」を1つふやす
          if (!mine && parent) { const up = await getRef(parent).catch(() => null); await putRef(parent, { kids: ((up && up.kids) || 0) + 1 }).catch(() => {}); }
          if (!mine && parent) S.newVisit = true;
          S.funnel = funnelOf(mine);
          S.costYen = (mine && mine.costYen) || 0;
          { const d0 = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10), born = mine && mine.at ? new Date(mine.at + 9 * 3600000).toISOString().slice(0, 10) : d0; S.firstDay = born === d0; }   // はじめて来た日は、長めに話せる・回数も多め
          if (S.newVisit && parent) tellUpline(S, 'ハタボと話しはじめました', 'visit').catch(() => {});
          if (mine && mine.stage === 'trial' && S.funnel.stage === 'contract' && !mine.thanked) { putRef(S.myRef, { stage: 'contract', thanked: true, contractAt: mine.trialUntil || Date.now() }).catch(() => {}); tellUpline(S, (S.funnel.lineupName || '') + ' ' + (S.funnel.grade || '') + 'を契約しました', 'contract').catch(() => {}); }
          // 紹介から来た人は、紹介した人のアバターで（コムギの紹介ならコムギ）。リッチメニューのサービス相談と、役割を決めた窓口はそのまま
          if (S.guest && !S.agent && !S.visit) {
            if (S.role !== '汎用' && S.role !== 'サービス相談') {
              // 役割を決めたURL（マー君の ?ref=mac など）で開いた人：そのアバターを自分のものとして覚える
              putRef(S.myRef, { avatar: S.avatar, avatarFixed: true }).catch(() => {});
            } else if (S.role === '汎用') {
              // ふだん：自分のアバターが決まっていればそれ。なければ、紹介した人（人の紹介コードだけ・3代まで）のアバターを引きつぐ
              let av = mine && mine.avatarFixed && AVS[mine.avatar] ? mine.avatar : '', c = parent;
              for (let i = 0; i < 3 && c && !av; i++) { const u = await getRef(c).catch(() => null); if (u && u.owner && AVS[u.avatar] && u.avatar !== 'hatabo') av = u.avatar; c = u && u.parent; }
              if (av && av !== S.avatar && AVS[av]) { S.system = S.system.replace(AVS[S.avatar].persona(), AVS[av].persona()); S.avatar = av; S.voice = AVS[av].voice(); }
              putRef(S.myRef, { avatar: S.avatar }).catch(() => {});
            }
          }
          // ご縁の人のAI棒をたずねる：つながっていれば、その人のアバターと「紹介してよいこと」だけで話す。話したことは、その人への伝言になる
          if (S.visit) {
            const sp = SPONSORS.find(x => x.id === S.visit);
            const t = sp ? null : S.visit !== S.myRef && await canTalk(S.myRef, S.visit) ? await getRef(S.visit).catch(() => null) : null;
            if (sp) {   // 協賛（会社）のAI棒
              S.visitHost = sp.name; S.visitLog = []; S.avatar = 'hatabo'; S.voice = AVS.hatabo.voice(); S.history = []; S.memo = ''; S.consult = ''; S.visitSponsor = true;
              S.system = HATABO_PERSONA + '\n\n【いまの役目：' + sp.name + 'のAI棒（協賛）】' + (sp.persona || '') + '\n会社の案内に関係ないことには答えない。うそや大げさなことは言わない。';
            } else
            if (!sp && !t) S.visit = '';
            else if (sp) {}
            else {
              const av = AVS[t.avatar] ? t.avatar : 'hatabo', host = String(t.name || 'ご縁の人'), pf = t.owner ? await loadProfile(t.owner).catch(() => null) : null;
              S.visitHost = host; S.visitLog = []; S.avatar = av; S.voice = AVS[av].voice(); S.history = []; S.memo = ''; S.consult = '';
              S.system = AVS[av].persona() + '\n\n【いまの役目：' + host + 'さんのAI棒】あなたはいま、' + host + 'さんのAI棒として、ご縁でつながった' + (S.me || 'お客さん') + 'さんと話している。' + host + 'さんの代わりに、ていねいに受け答えする。'
                + host + 'さんについて言ってよいのは、下の「紹介してよいこと」だけ。予定・住所・連絡先・お金・家族のことは言わない。わからないことは「' + host + 'さんに伝えておく」と言う。話した中身は、あとで' + host + 'さんに伝言として届くと最初に一度だけ伝える。'
                + (pf ? '\n【' + host + 'さんの紹介カード】得意なこと：' + (pf.skills || '—') + '\nさがしていること：' + (pf.seeking || '—') + '\n紹介してよいこと：' + (pf.shareable || '—') : '\n【' + host + 'さんの紹介カード】まだない。名前とご縁があることだけ言える。')
                + (S.me ? '\n\n【いま話している人】' + S.me + 'さん（LINEの名前）。' : '');
            }
          }
          S.stats = { at: (mine && mine.at) || Date.now(), tot: (mine && mine.tot) || 0, mon: (mine && mine.mon) || '', monN: (mine && mine.monN) || 0, last: (mine && mine.last) || '', streak: (mine && mine.streak) || 0, kids: (mine && mine.kids) || 0 };
        }
        // コムギ経由か：コムギの窓口、またはコムギの紹介コードから（2つ上までたどる）
        if (S.guest) {
          console.log('guest in', JSON.stringify({ owner: S.owner, name: S.me, ref: S.ref || '', avatar: S.avatar, myRef: S.myRef }));   // ミニアプリを移ると LINE のIDが変わるので、スーパー上位（SUPER_OWNERS）に入れるIDをここで見る
          let k = S.avatar === 'komugi', c = S.ref || S.refFrom;
          for (let i = 0; !k && c && i < 3; i++) { if (ENV.KOMUGI_REFS.includes(c)) k = true; else { const up = await getRef(c).catch(() => null); c = up && up.parent; } }
          if (k && !S.komugi && S.avatar === 'komugi') { S.komugi = true; S.system += komugiBlock(await komugiNews()); }
        }
        const pr = await loadPrefs(S.owner);
        S.custom = pr.custom ? cleanCustom(pr.custom) : null;
        const lp = S.guest ? await loadPrefs(GUEST_COMMON) : pr;      // 窓口は、ヒロさんがテストで教えたことをみんなで使う
        S.lessons = Array.isArray(lp.lessons) ? lp.lessons.slice(-30) : [];
        S.learned = Array.isArray(lp.learned) ? lp.learned.slice(-20) : [];
        S.trio = S.guest ? false : typeof m.trio === 'boolean' ? m.trio : !!pr.trio;
        if (typeof pr.waitMs === 'number') S.waitMs = pr.waitMs;
        if (convoKey() && !S.asGuest) {      // テスト（&test=guest）は毎回まっさらから（前のテストの話を混ぜない）
          const c = await loadConvo(convoKey());
          if (c) {
            S.memo = String(c.summary || '');
            if (Date.now() - (c.at || 0) < 12 * 3600000) S.history = cleanTurns(c.turns);
            S.newTurns = Number(c.newTurns || 0);
            if (S.newTurns >= 2) setTimeout(summarize, 3000);       // 前回まとめきれなかった分（強制で切ったときなど）
          }
        }
        // ヒロさんの家族のジュニアと、マー君のコムギは、いつもClaudeと同じ（スーパー上位・答えの長さの決まりなし）
        S.claude = !S.visit && ((ENV.CLAUDE_FAMILY && !S.guest && !S.asGuest) || /コムギ/.test(S.role || '') || !!superUntil(S.owner) || !!(S.myRef && S.avatar === 'komugi' && (await getRef(S.myRef).catch(() => null) || {}).avatarFixed));
        if ((S.avatar === 'hatabo' || S.avatar === 'komugi' || S.app === 'hatabo') && !/【聞き取りのくせ】/.test(S.system)) S.system += HEAR_RULE;
        // ハタボの伝え先：招待した人がいればその人、いなければ「ハタボの事務局」（運営の個人の名前は出さない）
        if (S.avatar === 'hatabo' && !S.visit) {
          let to = 'ハタボの事務局';
          try { let up = S.refFrom ? await getRef(S.refFrom) : null; if (up && up.kind === 'group') up = up.parent ? await getRef(up.parent) : null; if (up && up.owner && up.name) to = up.name + 'さん'; } catch (e) {}
          S.tellTo = to;
          S.system = S.system.replace(/ハタラボの担当（ヒロさん）|ハタラボのヒロさん/g, to).replace(/〈伝え先〉/g, to).replace(/ヒロさん/g, to);
        }
        send({ type: 'ready', me: S.me, mode: S.mode, voice: S.voice || ENV.TTS_VOICE, profile: S.owner ? await loadProfile(S.owner).catch(() => null) : null, trio: S.trio, waitMs: S.waitMs, guest: !!S.guest, service: S.role === 'サービス相談', myRef: S.myRef || '', visit: S.visit ? { code: S.visit, name: S.visitHost } : null, avatar: S.avatar || '', komugi: !!S.komugi, superUntil: superUntil(S.owner), canPlan: !!(S.claude || superUntil(S.owner)), claude: !!S.claude, aiName: !S.visit && S.custom && S.custom.aiName || '' });
        if (S.visit) { const T = S.avatar === 'komugi' ? x => x.replace(/だボー/g, 'です').replace(/ボー/g, 'です') : S.avatar === 'hatabo' ? x => x : x => x.replace(/だボー/g, 'だぜ').replace(/ボー/g, 'ぜ'); return speakOnly(T(S.visitSponsor ? S.visitHost + 'のAI棒だボー。なんでも聞いてほしいボー。' : S.visitHost + 'さんのAI棒だボー。話してくれたことは、' + S.visitHost + 'さんに伝言で届けるボー。'), 'excited'); }
        if (m.greet && S.guest && S.consult) return recapGreet().then(deliverInbox).catch(() => {});      // 相談メモがある人には、振り返りからはじめる
        const hi = m.greet ? (S.guest ? (S.history.length ? (AVS[S.avatar] ? AVS[S.avatar].again : 'よう、また来てくれたな！つづきを話そうぜ。') : (AVS[S.avatar] ? greetFor() : guestGreeting(S.me))) : greeting(S.me, S.mode, S.trio)) : '';
        if (hi) await speakOnly(hi, 'excited');
        if (m.greet) deliverInbox().catch(() => {});
        return;
      }
      if (!S.ready) return;
      if (m.type === 'barge') return stopReply('barge');
      if (m.type === 'text') return onHeard(String(m.text || '').slice(0, 500));
      if (m.type === 'photo') return onPhoto(m);
      if (m.type === 'trio') return setTrio(!!m.on);
      if (m.type === 'plan') {                      // 料金プランのおためし：ヒロさんの家族の画面だけ（お客さんからは受けつけない）
        if (!S.claude && !superUntil(S.owner) && (S.guest || S.asGuest || S.mode !== 'family')) return;
        S.planChosen = true;   // 期限つきの人（マー君など）は窓口でも自分で選べる
        S.plan = PLANS[m.plan] ? String(m.plan) : 'std';
        return send({ type: 'plan', plan: S.plan, label: PLANS[S.plan].label });
      }
      if (m.type === 'save_media') {               // 写真・動画をおうちのドライブへ（家族だけ）
        if (S.guest || S.asGuest) return;
        const data = String(m.data || '').replace(/^data:[\w/+.-]+;base64,/, '');
        if (!data || data.length > 14 * 1024 * 1024) return send({ type: 'notice', why: 'media', detail: '大きすぎて保存できませんでした' });
        try {
          const g = await gas(Object.assign({ action: 'media', kind: m.kind === 'video' ? 'video' : 'photo', mime: String(m.mime || 'image/jpeg').slice(0, 40), data }, S.auth));
          if (g && g.ok && g.url) send({ type: 'links', links: [{ title: (m.kind === 'video' ? '動画' : '写真') + 'をドライブに保存したぜ', url: g.url }] });
          else send({ type: 'notice', why: 'media', detail: String(g && (g.detail || g.error) || '').slice(0, 80) });
        } catch (e) { send({ type: 'notice', why: 'media', detail: String(e.message).slice(0, 80) }); }
        return;
      }
      if (m.type === 'loc') {                       // 「近く」を聞かれたときだけ、ページから届く（このつながりの間だけ使う）
        const lat = Number(m.lat), lon = Number(m.lon);
        if (isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) S.placeP = placeOf(lat, lon).then(p => { S.place = p; });
        return;
      }
      if (m.type === 'say') { if (S.guest || !quotaOk(S.owner || 'anon')) return; return speakOnly(clean(String(m.text || '')).slice(0, 200), 'smile', String(m.as || 'お知らせ').slice(0, 10), !!m.nobubble); }
      if (m.type === 'mode' && S.guest) return;
      if (m.type === 'mode') {
        if (S.newTurns >= 2) await summarize();
        S.mode = m.mode === 'business' ? 'business' : 'family'; S.history = []; S.memo = ''; S.newTurns = 0;
        await loadBrain();
        const c = convoKey() ? await loadConvo(convoKey()) : null;
        if (c) { S.memo = String(c.summary || ''); if (Date.now() - (c.at || 0) < 12 * 3600000) S.history = cleanTurns(c.turns); }
        return send({ type: 'mode', mode: S.mode });
      }
      if (m.type === 'profile') return onProfile(m);
      if (m.type === 'goen') return onGoen(m);
      if (m.type === 'ping') return send({ type: 'pong' });
      if (m.type === 'mypage') return send(await myPage(S));
      if (m.type === 'goen_tree') return send(await goenTree(S));
      if (m.type === 'funnel') return onFunnel(m);
      if (m.type === 'gacha') return onGacha(m);
      if (m.type === 'google_status') { const g = await gGet(S.owner); return send({ type: 'google', ready: !!ENV.GOOGLE_CLIENT_ID, linked: !!g.refresh, email: g.email || '', auto: g.auto !== false }); }
      if (m.type === 'google_link') { if (!S.owner || !ENV.GOOGLE_CLIENT_ID) return send({ type: 'google', ready: !!ENV.GOOGLE_CLIENT_ID, linked: false }); const n = crypto.randomBytes(16).toString('hex'); gNonce.set(n, { owner: S.owner, at: Date.now() }); if (gNonce.size > 500) gNonce.clear(); return send({ type: 'google_url', url: ENV.PUBLIC_URL + '/google/start?n=' + n }); }
      if (m.type === 'google_auto') { await saveCol(gDocKey(S.owner), 'google', { auto: !!m.on }); const g = await gGet(S.owner); return send({ type: 'google', ready: true, linked: !!g.refresh, email: g.email || '', auto: g.auto !== false }); }
      if (m.type === 'google_unlink') { const g = await gGet(S.owner); if (g.refresh) { try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(gDec(g.refresh)), { method: 'POST' }); } catch (e) {} } await saveCol(gDocKey(S.owner), 'google', { refresh: '', email: '', folder: '' }); return send({ type: 'google', ready: !!ENV.GOOGLE_CLIENT_ID, linked: false }); }
      if (m.type === 'note_drive') { const items = await loadNotes(S.owner), it = items.find(x => x.id === String(m.id || '')); if (it) { it.url = await driveSave(S.owner, it.title, it.text).catch(() => null) || it.url || ''; await saveNotes(S.owner, items); } return send(Object.assign(await myPage(S), { driveMsg: it && it.url ? 'Googleドライブに保存しました' : 'Googleドライブに保存できませんでした' })); }
      if (m.type === 'custom_get') return send({ type: 'custom', c: S.custom || cleanCustom({}), tones: TONES, lens: LENS, named: !!(S.custom && S.custom.aiName) });
      if (m.type === 'custom_set') {
        if (!S.owner || S.visit) return;
        const c = cleanCustom(m.c), old = S.custom || {};
        if (old.aiName && c.aiName !== old.aiName && !m.renameOk) c.aiName = old.aiName;   // 名前の変更はオプション（最初の名付けは無料）
        S.custom = c; await savePrefs(S.owner, { custom: c });
        return send({ type: 'custom', c, tones: TONES, lens: LENS, named: !!c.aiName, saved: true, aiName: c.aiName });
      }
      if (m.type === 'rename_req') { gas(Object.assign({ action: 'lead', lead: { who: S.me, ref: '', kind: '契約', title: 'AI棒の名前の変更（1,000円）：' + String(m.name || '').slice(0, 12), need: '名前の変更', when: '', budget: '1,000円', next: 'お支払いのあと名前を変える', memo: '' } }, S.auth)).catch(() => {}); return send({ type: 'notice', why: 'rename', detail: '名前の変更を申し込みました。お支払いの案内のあと変わります' }); }
      if (m.type === 'ticket') return onTicket(m);
      if (m.type === 'friends') return send(await friendsView());
      if (m.type === 'friend_req' || m.type === 'friend_ok' || m.type === 'friend_no' || m.type === 'friend_del') return onFriend(m);
      if (m.type === 'social') { const r = { gachaOn: m.gachaOn !== false, showLine: !!m.showLine, showInsta: !!m.showInsta, lineId: String(m.lineId || '').trim().slice(0, 40), insta: String(m.insta || '').trim().replace(/^@/, '').slice(0, 40) }; if (S.myRef) await putRef(S.myRef, r); return send(await friendsView()); }
      if (m.type === 'inbox') return send({ type: 'inbox', items: await loadInbox(S.myRef), people: (await goenPeople(S.myRef).catch(() => [])).slice(0, 60) });
      if (m.type === 'inbox_send') {
        const to = String(m.to || ''), t = String(m.text || '').trim().slice(0, 500);
        if (!t || !(await canTalk(S.myRef, to))) return send({ type: 'notice', why: 'inbox', detail: 'ご縁でつながった人と友だちにだけ送れます' });
        await postInbox(to, { kind: 'msg', from: S.myRef, fromName: S.me || 'ご縁の人', text: t });
        return send({ type: 'inbox', items: await loadInbox(S.myRef), people: (await goenPeople(S.myRef).catch(() => [])).slice(0, 60), sent: true });
      }
      if (m.type === 'inbox_read') { const items = await loadInbox(S.myRef); items.forEach(x => { x.read = true; }); await saveInbox(S.myRef, items); return send({ type: 'inbox', items, people: (await goenPeople(S.myRef).catch(() => [])).slice(0, 60) }); }
      if (m.type === 'note_del') { const items = (await loadNotes(S.owner)).filter(x => x.id !== String(m.id || '')); await saveNotes(S.owner, items); return send(await myPage(S)); }
    } catch (e) { send({ type: 'notice', why: 'server', detail: String(e.message).slice(0, 80) }); }
  });
  const life = setTimeout(() => fail('timeout', 'つなぎっぱなしの上限'), ENV.SESSION_MAX_MIN * 60000);
  ws.on('close', () => { clearTimeout(life); stopReply('close'); if (S.stt) { try { S.stt.end(); } catch (e) {} } if (S.visit && !S.visitSponsor && S.visitLog && S.visitLog.length) postInbox(S.visit, { kind: 'msg', from: S.myRef, fromName: S.me || 'ご縁の人', text: 'あなたのAI棒と話しました：' + S.visitLog.slice(-6).map(x => '「' + x + '」').join('') }).catch(() => {}); else if (S.newTurns >= 2) summarize(); });
  return S;
}

/* ===== HTTP と WebSocket ===== */
function createServer() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/google/')) return googleHttp(req, res);
    if (req.url.startsWith('/line/webhook') && req.method === 'POST') return lineWebhook(req, res, /\/komugi/.test(req.url) ? 'komugi' : 'hatabo');   // /line/webhook/komugi はコムギの公式LINE
    if (req.url === '/' || req.url.startsWith('/health')) { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('バターちゃんジュニア：元気だよ'); }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({
    server, path: '/talk', maxPayload: 16 * 1024 * 1024,
    verifyClient: info => { const o = info.origin || ''; return !o || ENV.ALLOWED_ORIGINS.some(a => o === a || o.endsWith('.' + a.replace(/^https?:\/\//, ''))); },
  });
  wss.on('connection', ws => session(ws));
  return server;
}

if (require.main === module) {
  deps.init();
  createServer().listen(ENV.PORT, () => console.log('butter-junior on :' + ENV.PORT));
}
module.exports = { createServer, deps, ENV, splitter, takeEmotion, clean, PHOTO_RE, VIDEO_RE, session, calledJunior, calledJam };
