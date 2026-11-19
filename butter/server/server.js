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
  // コムギ（馬越さん）：窓口の役割に「コムギ」と書いた窓口は、見た目がコムギになる
  KOMUGI_REFS: (process.env.KOMUGI_REFS || '').split(',').map(s => s.trim()).filter(Boolean),   // コムギの紹介コード（ここから来た人はコムギ通信つき）
  EL_KEY: process.env.ELEVENLABS_API_KEY || '',   // ElevenLabs のAPIキー。声の名前を「el:声のID」にすると ElevenLabs で話す
  EL_MODEL: process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5',   // 速さ重視 eleven_flash_v2_5／表現重視 eleven_v3 など
  EL_FORMAT: process.env.ELEVENLABS_FORMAT || 'mp3_44100_128',   // 声の音質。64kbpsだとスマホでザラザラ（ノイズ）に聞こえやすいので128kbps
  OPENAI_KEY: process.env.OPENAI_API_KEY || '',   // GPT-Live-1 の検証用（ハタリス）。Secret Managerから入れる
  LIVE_KEY: process.env.LIVE_KEY || '',             // 検証ページの合言葉（ないと使えない）
  LIVE_VOICE: process.env.LIVE_VOICE || 'marin',    // GPT-Live-1 の声
  LIVE_DAILY: Number(process.env.LIVE_DAILY || 40),  // 1日に始められる回数（ぜんぶで）
  LIVE_MAX_MIN: Number(process.env.LIVE_MAX_MIN || 15),   // 1回の長さの上限（分）
  EOU_MS: Number(process.env.EOU_MS ?? 800),   // 話し終わりの見分け：聞き取りの文字がこの時間（ミリ秒）かわらなければ、話し終わりとみなしてすぐ返事を始める（0でGoogleまかせ）
  HATABO_VOICE: process.env.HATABO_VOICE || 'ja-JP-Chirp3-HD-Puck',   // ハタボの声：明るく元気な、ひよこの男の子（ジュニアのガラガラ声とは別）
  KOMUGI_VOICE: process.env.KOMUGI_VOICE || 'ja-JP-Chirp3-HD-Leda',   // コムギの声：やわらかい少女の声
  KOMUGI_RATE: Number(process.env.KOMUGI_RATE || 1.1),   // コムギの話す速さ（1が標準。11/19 ヒロさんの希望で少し速く）
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
  KOMUGI_OWNERS: (process.env.KOMUGI_OWNERS || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean),   // 馬越さんと同じ使い方でコムギを相棒にする人（ヒロさんなど）のLINEのID。制限なし・自分の資料・紹介カードなし。紹介の手数料や通知は馬越さんのまま
  SUPER_OWNERS: (process.env.SUPER_OWNERS || '').split(',').map(s => s.trim()).filter(Boolean),
  MAC_OWNERS: (process.env.MAC_OWNERS || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean),   // 馬越さんのLINEのID（「g:」つきでもなしでも。期限は最後に「:YYYY-MM-DD」）。コムギを制限なしで使える・紹介の手数料の受け取り手
  SITE_URL: process.env.SITE_URL || '',   // ハタボのサービスサイト（公開したらURLを入れる。トーク・カード・Myハタボから、ときどき案内する）
  OFFICE_OWNERS: (process.env.OFFICE_OWNERS || '').split(/[,\s]+/).map(s => s.trim().replace(/^g:/, '')).filter(Boolean),   // ハタボ事務局（ヒロさん）のLINEのID。事務局への声・問い合わせ・友だち追加などを1日1回まとめて届ける
  CRON_KEY: process.env.CRON_KEY || '',   // 1日1回のまとめを送る合図（Cloud Scheduler から /cron/digest?key=…）
  BRIDGE_DAILY: Number(process.env.BRIDGE_DAILY || 20),   // 馬越さんの紹介でコムギと話す人の1日の回数（契約したらグレードの回数）
};
/** 期限つきでスーパー上位を使える人か */
function idUntil(list, owner) {
  if (!owner) return '';
  for (const x of list) {
    // 「g:」つき（ハタボのアプリ）でも、なしでも書ける。期限は最後の「:YYYY-MM-DD」
    const mm = String(x).match(/^(.*?)(?::(\d{4}-\d{2}-\d{2}))?$/), id = (mm && mm[1] || '').replace(/^g:/, ''), until = mm && mm[2];
    if (id && (id === owner || 'g:' + id === owner) && (!until || Date.now() < new Date(until + 'T23:59:59+09:00').getTime())) return until || '無期限';
  }
  return '';
}
/** 期限つきでスーパー上位を使える人か（馬越さんも、検証のあいだは制限なし） */
const superUntil = owner => idUntil(ENV.SUPER_OWNERS, owner) || idUntil(ENV.MAC_OWNERS, owner) || idUntil(ENV.KOMUGI_OWNERS.map(x => String(x).replace(/=[^:]*/, '')), owner);
/** 馬越さんと同じ使い方のコムギの持ち主か（馬越さん本人はのぞく） */
const koId = x => String(x).replace(/=.*$/, '').replace(/:\d{4}-\d{2}-\d{2}$/, '').replace(/^g:/, '');   // 書き方：ID または ID=呼び名（例 Uxxxx=ヒロ）
const isKomugiOwner = owner => !!owner && ENV.KOMUGI_OWNERS.some(x => { const id = koId(x); return id && (owner === id || owner === 'g:' + id); });
const komugiOwnerName = owner => { const x = ENV.KOMUGI_OWNERS.find(y => { const id = koId(y); return id && (owner === id || owner === 'g:' + id); }); return x && /=/.test(x) ? String(x).split('=')[1].trim() : ''; };
/** 馬越さん本人か */
const isMac = owner => !!owner && ENV.MAC_OWNERS.some(x => { const id = String(x).replace(/:\d{4}-\d{2}-\d{2}$/, '').replace(/^g:/, ''); return id && (owner === id || owner === 'g:' + id); });   // 期限がすぎても馬越さんは馬越さん（制限なしだけが期限まで。そのあとは契約したグレード）
/** 馬越さんの紹介コード（馬越さんあての伝言・案件・手数料の行き先） */
const macRefs = () => ENV.MAC_OWNERS.map(x => String(x).replace(/:\d{4}-\d{2}-\d{2}$/, '').replace(/^g:/, '')).filter(Boolean).map(id => myRefOf('g:' + id));

// 料金プランのおためし（ヒロさんの家族の画面だけ）：同じ質問を3つの賢さで聞きくらべる
//   std＝いまのまま（ふだん速いモデル、むずかしい時だけ賢いモデル）
//   high＝ぜんぶ一番賢いモデル
//   super＝一番賢いモデル＋長い記憶（会話を倍おぼえる）＋長めの答え＋検索を多めに
/* 記憶（11/19）：メモリー＝直近の会話（turns：返事に使う数、keep：残す数。どちらも発言の数で、往復はその半分）、holdH＝何時間あとまで続きから話せるか。
   ハード＝AIDごとのメモ帳（memFiles：ファイルの数、memChars：1ファイルの字数）。話しはじめは目次だけ読み、話題が出たら中身を読む */
const PLANS = {
  std:   { label: '標準',       premium: false, turns: 12, keep: 24, extraTokens: 0,   maxUses: 3, extraSent: 0, holdH: 12, memFiles: 10, memChars: 600 },
  high:  { label: '上位',       premium: false, smart: true, turns: 16, keep: 32, extraTokens: 500, maxUses: 3, extraSent: 1, holdH: 72, memFiles: 30, memChars: 1200 },   // G：賢いモデルで、少し短めに（Zの半分くらいの費用）
  super: { label: 'スーパー上位', premium: true,  turns: 24, keep: 48, extraTokens: 260, maxUses: 5, extraSent: 1, long: true, holdH: 168, memFiles: 100, memChars: 2000 },   // 長文もClaudeと同じように書ける（声は最初だけ、続きは吹き出しに）
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
  [/(?:まーくん|マークン|馬越さんさん|まあくん)/g, '馬越さん'],
];
const hearFix = t => HEAR_FIX.reduce((x, [re, to]) => x.replace(re, to), String(t || ''));
// あいまいな言い方や聞き間違いを、Claudeのように話の流れからくみ取る
const HEAR_RULE = '\n\n【聞き取りのくせ】相手の言葉は声の文字起こしなので、音の近い言葉への聞き間違い（例：ハタボ→あたご・畑葉、AI棒→相棒、コムギ→小麦）や、言いさし・言い直しがまじる。おかしな言葉は、音の近さと前後の話の流れから、いちばんありそうな意味にくみ取って、そのまま答える。くみ取った意味を言いなおして確かめることはしない。どうしても二通り以上に取れて、答えが大きく変わるときだけ、「〇〇のことですか？」と短く一度だけ確かめる。よく出る言葉：ハタボ（AI棒・愛棒）、ハタラボ（HATHA LAB）、ハタイエンタ・ハタリス・ハタボックス・ハタエース・ハタボーラ（ラインナップ）、AISAI・愛祭、Myハタボ（マイハタボ）、ご縁、伝言、ガチャ、チケット、コムギ、馬越さん、ヒロさん。';
const LONG_RULE = '\n\n【長い文章】いまは長い文章を頼まれている。ふだんの「1〜2文」の決まりは使わず、Claudeと同じように、頼まれた中身を最後まで、見出しや箇条書きも使ってしっかり書く（声で読むのは最初の数文だけで、続きは画面の吹き出しに出る）。最初の1〜2文は、声で聞いてわかる短い前おき（例：「書いたよ。画面を見てね」）にする。';
/* ===== 紹介 → お試し → 契約（ラインナップとグレード）。サイトのプラン・料金と同じ ===== */
const LINEUP = {
  ietna: { name: 'ハタイエンタ', who: '家族の愛棒', grades: { X: '5,980円', G: '12,800円' } },
  ris:   { name: 'ハタリス',     who: 'ひとりの愛棒', grades: { X: '2,980円', G: '4,980円', Z: '12,800円' } },   // コムギ（馬越さん）は、ハタリスZクラスのオーダーメイド（専用キャラ）
  box:   { name: 'ハタボックス', who: '個人事業の愛棒', grades: { X: '5,000円', G: '担当がご案内', Z: '担当がご案内' } },
  ace:   { name: 'ハタエース',   who: 'お店・宿の愛棒', grades: { X: '10,000円〜', G: '担当がご案内' } },
  bora:  { name: 'ハタボーラ',   who: '会社の愛棒', grades: { X: '1席 2,980円', G: '1席 9,800円' } },
};
const GRADE_PLAN = { X: 'std', G: 'high', Z: 'super' };
const TRIAL_DAYS = 7, TRIAL_FIRST = 30, TRIAL_DAILY = 15;   // お試し：7日間、初日30回・2日目から1日15回
const TRIAL_TEXT = '初日' + TRIAL_FIRST + '回、2日目から1日' + TRIAL_DAILY + '回まで';
const trialCap = f => f && f.trialAt && new Date(f.trialAt).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10) ? TRIAL_FIRST : TRIAL_DAILY;
const GRADE_CAP = { std: 60, high: 40, super: 30 };
/** ハタイエンタ：家族で1日の回数を分け合う（1人の上限は GRADE_CAP）。6人目から1人980円 */
const FAMILY_POOL = { X: 150, G: 100 };
function familyOk(S) {
  const f = S && S.funnel;
  if (!f || f.lineup !== 'ietna' || f.stage !== 'contract' || !FAMILY_POOL[f.grade]) return true;
  const k = 'fam:' + (f.family || S.myRef || S.owner || 'anon') + ':' + new Date().toISOString().slice(0, 10), n = (counts.get(k) || 0) + 1;
  counts.set(k, n); countSave(k);
  return n <= FAMILY_POOL[f.grade];
}   // ハタボの1日の回数（X・G・Z）。こえたら追加チケット
/** ありがとうポイント：紹介した人に。2代目のご縁の人には半分 */
const THANKS = { visit: 100, trial: 300, contract: 1000 };
/** いまの段階：お試しの7日が過ぎたら、選んだプランの契約に切りかわる */
function funnelOf(r) {
  r = r || {};
  let stage = r.stage || '';
  if (stage === 'trial' && Date.now() > (r.trialUntil || 0)) stage = 'contract';
  const L = LINEUP[r.lineup] || null;
  return { stage, lineup: r.lineup || '', lineupName: L ? L.name : '', grade: r.grade || '', price: L && L.grades[r.grade] || '', pay: r.pay || 'm',
    trialUntil: r.trialUntil || 0, trialAt: r.trialAt || 0, family: r.family || '', daysLeft: stage === 'trial' ? Math.max(1, Math.ceil(((r.trialUntil || 0) - Date.now()) / 86400000)) : 0 };
}
const planOf = S => S && S.claude && !S.planChosen ? PLANS.super : S && S.funnel && S.funnel.stage === 'trial' ? PLANS.super : S && S.funnel && S.funnel.stage === 'contract' && GRADE_PLAN[S.funnel.grade] && S.guest ? PLANS[GRADE_PLAN[S.funnel.grade]] : _planOf(S);
const _planOf = S => S && S.guest && (!!S.agent || isSanboRole(S.role) || (S.ref && ENV.SUPER_REFS.includes(String(S.ref).toLowerCase()))) ? PLANS.super : S && superUntil(S.owner) ? (PLANS[S.plan] || PLANS.super) : PLANS[S && !S.guest && !S.asGuest && S.mode === 'family' && PLANS[S.plan] ? S.plan : 'std'];

/* ===== 「考える（thinking）」の切りかた：モデルが受けつける形を順にためす（disabled → between_tools → つけずに枠を広げる） ===== */
const THINK = { modes: ['disabled', 'between_tools', ''], i: 0 };
function thinkPrep(p) {
  const m = THINK.modes[THINK.i], q = Object.assign({}, p);
  if (m && !q.thinking) q.thinking = { type: m };
  if (m !== 'disabled') q.max_tokens = (q.max_tokens || 0) + 1500;   // 考える分の余白
  return q;
}
function thinkNext(e) {
  const t = String(e && e.message || e);
  if (/thinking/i.test(t) && /400|invalid|not supported|unsupported/i.test(t) && THINK.i < THINK.modes.length - 1) { THINK.i++; console.error('thinking mode →', THINK.modes[THINK.i] || '(なし)'); return true; }
  return false;
}
/* ===== 外のサービス（テストでは差しかえる） ===== */
const deps = {
  claude: null, stt: null, tts: null, db: null,
  init() {
    if (!this.claude) {
      const Anthropic = require('@anthropic-ai/sdk'), c = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), M = c.messages;
      // 5.5の世代は、なにも言わないと「考える」がオンで、短い max_tokens を考えるだけで使いきって返事が空になる。声の会話では考えるをオフに
      this.claude = { messages: {
        stream: p => M.stream(thinkPrep(p)),
        create: async p => { for (;;) { try { return await M.create(thinkPrep(p)); } catch (e) { if (thinkNext(e)) continue; throw e; } } },
      } };
    }
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
/** 回数はメモリーで数えつつ、ハード（counts）にも足していく。サーバーが立ち上げ直されても、話しはじめに読みもどす */
function countSave(k) {
  try { if (deps.db) { const { FieldValue } = require('@google-cloud/firestore'); deps.db.collection('counts').doc(k.replace(/\//g, '_')).set({ n: FieldValue.increment(1), at: Date.now() }, { merge: true }).catch(() => {}); } } catch (e) {}
}
async function countLoad(keys) {
  if (!deps.db) return;
  for (const k of keys) { try { const d = await deps.db.collection('counts').doc(k.replace(/\//g, '_')).get(); if (d.exists) counts.set(k, Math.max(counts.get(k) || 0, Number(d.data().n) || 0)); } catch (e) {} }
}
function quotaOk(owner, guest, hasRef, cap) {
  const day = new Date().toISOString().slice(0, 10), k = owner + ':' + day;
  const n = (counts.get(k) || 0) + 1;
  counts.set(k, n); countSave(k);
  if (counts.size > 5000) counts.clear();
  if (!guest) return n <= ENV.DAILY_LIMIT;
  const tk = '__guests:' + day, t = (counts.get(tk) || 0) + 1;      // 窓口ぜんぶの上限
  counts.set(tk, t); countSave(tk);
  return t <= ENV.GUEST_TOTAL_LIMIT && n <= (cap || (hasRef ? ENV.DAILY_LIMIT_GUEST : ENV.DAILY_LIMIT_NOREF));
}

/* ===== 紹介のつながり：一人ひとりの紹介コード（refs）。だれの紹介で来たかを、最初の1回だけ覚える ===== */
const memRefs = new Map();
const myRefOf = owner => Array.from(crypto.createHash('sha256').update('ref:' + owner).digest()).slice(0, 6).map(b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
/** 自分の紹介コード：ふだんは myRefOf と同じ。もう別の人が使っていたら（かぶり）、作り直して覚えておく */
async function myRefFor(owner) {
  if (!owner) return '';
  try { if (deps.db) { const m = await deps.db.collection('refowners').doc(crypto.createHash('sha256').update(owner).digest('hex').slice(0, 32)).get(); if (m.exists && m.data().code) return m.data().code; } } catch (e) {}
  for (let i = 0; i < 6; i++) {
    const code = i ? myRefOf(owner + '#' + i) : myRefOf(owner);
    const r = await getRef(code).catch(() => null);
    if (!r || !r.owner || r.owner === owner) {
      if (i) { console.log('ref collision', code); try { if (deps.db) await deps.db.collection('refowners').doc(crypto.createHash('sha256').update(owner).digest('hex').slice(0, 32)).set({ code, at: Date.now() }); } catch (e) {} }
      return code;
    }
  }
  return myRefOf(owner);
}
const REF_DAYS = 90;   // 紹介の期限：90日のあいだにお試しも契約もなければ切れて、あとから紹介した人が紹介者になる
/** ヒアリング役の紹介コードを、その人（LINEのID）に結びつけて覚える。公式LINEのメニューやトークのボタンから（紹介コードなしで）開いても、同じヒアリングと相談メモで話せるように */
const pinMem = new Map();
const pinId = owner => crypto.createHash('sha256').update('pin:' + owner).digest('hex').slice(0, 32);
async function getPin(owner) {
  if (!owner) return '';
  try { if (deps.db) { const d = await deps.db.collection('refpins').doc(pinId(owner)).get(); return d.exists ? String(d.data().ref || '') : ''; } } catch (e) {}
  return pinMem.get(owner) || '';
}
async function setPin(owner, ref) {
  if (!owner) return;
  try { if (deps.db) return void await (ref ? deps.db.collection('refpins').doc(pinId(owner)).set({ ref, at: Date.now() }) : deps.db.collection('refpins').doc(pinId(owner)).delete()); } catch (e) {}
  if (ref) pinMem.set(owner, ref); else pinMem.delete(owner);
}
async function getRef(code) {
  if (!code) return null;
  try { if (deps.db) { const d = await deps.db.collection('refs').doc(code).get(); return d.exists ? d.data() : null; } } catch (e) {}
  return memRefs.get(code) || null;
}
async function putRef(code, data) {
  try { if (deps.db) return void await deps.db.collection('refs').doc(code).set(data, { merge: true }); } catch (e) {}
  memRefs.set(code, Object.assign(memRefs.get(code) || {}, data));
}
/** Myハタボの数字：話した回数（ぜんぶ・今月）、毎日つづけた日数。紹介コードのところに覚える */
function bumpStats(S) {
  if (!S || !S.myRef || !S.stats) return;
  const st = S.stats, now = new Date(Date.now() + 9 * 3600000), day = now.toISOString().slice(0, 10), mon = day.slice(0, 7);
  st.tot++; if (st.mon !== mon) { st.mon = mon; st.monN = 0; } st.monN++;
  if (st.last !== day) { const y = new Date(now.getTime() - 86400000).toISOString().slice(0, 10); st.streak = st.last === y ? st.streak + 1 : 1; st.last = day; }
  putRef(S.myRef, { tot: st.tot, mon: st.mon, monN: st.monN, last: st.last, streak: st.streak }).catch(() => {});
}
/** ハタボ・コムギのアプリでは、グレードごとの1日の回数 */
const gradeCap = S => S && S.bridge && !(S.funnel && (S.funnel.stage === 'contract' || S.funnel.stage === 'trial')) ? ENV.BRIDGE_DAILY : (S && (S.avatar === 'hatabo' || S.avatar === 'komugi')) ? (S.firstDay ? 50 : 0) || GRADE_CAP[Object.keys(PLANS).find(k => PLANS[k] === planOf(S)) || 'std'] : 0;
async function myPage(S) {
  const plan = planOf(S), st = S.stats || {}, day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const used = counts.get((S.owner || 'anon') + ':' + new Date().toISOString().slice(0, 10)) || 0;
  const limit = !S.guest ? ENV.DAILY_LIMIT : gradeCap(S) || (S.refFrom ? ENV.DAILY_LIMIT_GUEST : ENV.DAILY_LIMIT_NOREF);
  const mine = S.myRef ? await getRef(S.myRef).catch(() => null) : null;
  const tot = st.tot || 0, lv = Math.floor(Math.sqrt(tot / 4)) + 1, base = Math.pow(lv - 1, 2) * 4, next = Math.pow(lv, 2) * 4;
  return { type: 'mypage', site: ENV.SITE_URL, name: S.me || '', avatar: S.avatar || 'hatabo', plan: plan.label, superUntil: superUntil(S.owner) || (plan === PLANS.super && S.guest ? 'サイトからのおためし' : ''),
    unlimited: !!(superUntil(S.owner) || S.macSelf), monthYen: mine && mine.costMon === day.slice(0, 7) ? mine.costMonYen || 0 : 0,
    today: used, limit, month: st.mon === day.slice(0, 7) ? st.monN || 0 : 0, total: tot, days: st.at ? Math.max(1, Math.ceil((Date.now() - st.at) / 86400000)) : 1,
    streak: st.last === day || st.last === new Date(Date.now() - 15 * 3600000).toISOString().slice(0, 10) ? st.streak || 0 : 0,
    lv, lvPct: Math.round((tot - base) / Math.max(1, next - base) * 100), learned: (S.learned || []).length + (S.lessons || []).length,
    kids: (mine && mine.kids) || 0, myRef: S.myRef || '', from: S.refFrom ? await refLabel(S.refFrom) : '',
    pts: (mine && mine.pts) || 0, thanks: THANKS, tickets: (mine && mine.tickets) || 0, ticketPacks: TICKETS,
    unread: S.myRef ? (await loadInbox(S.myRef).catch(() => [])).filter(x => !x.read).length : 0,
    funnel: S.funnel || funnelOf(mine), lineups: LINEUP, trialDays: TRIAL_DAYS, trialDaily: TRIAL_DAILY, trialFirst: TRIAL_FIRST,
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
  let wave = [S.myRef].concat(isMac(S.owner) ? ['mac'].concat(ENV.KOMUGI_REFS) : []);   // 馬越さんは、コムギの紹介コード（mac など）から来た人も自分のご縁
  for (let d = 1; d <= 5 && wave.length && nodes.length < 300; d++) {
    const next = [];
    for (const c of wave) {
      for (const k of await refKids(c)) {
        if (nodes.length >= 300 || nodes.some(n => n.id === k.code)) continue;
        nodes.push(Object.assign({ id: k.code, name: String(k.name || 'ゲスト').slice(0, 12), depth: d }, refStatus(k)));
        links.push({ from: nodes.some(n => n.id === c) ? c : S.myRef, to: k.code }); next.push(k.code);
      }
    }
    wave = next;
  }
  const byDepth = [1, 2, 3, 4, 5].map(d => nodes.filter(n => n.depth === d).length);
  return { type: 'goen', nodes, links, byDepth, pts: me.pts || 0, up: S.refFrom ? await refLabel(S.refFrom) : '' };
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
async function postInbox(code, item, chId) {
  if (!code) return;
  const items = await loadInbox(code);
  items.unshift(Object.assign({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), read: false }, item));
  await saveInbox(code, items);
  const r = await getRef(code).catch(() => null), to = r && /^g:U[0-9a-f]{32}$/.test(r.owner || '') ? r.owner.slice(2) : '';
  // LINEへは、すぐ送らずに1日1回のまとめに入れる（/cron/digest）
  if (to) { const head = item.kind === 'goen' ? 'ご縁' : (item.fromName || 'ご縁の人') + 'さんから伝言'; await queueDigest(to, chId === 'komugi' ? 'komugi' : 'hatabo', '［' + head + '］' + String(item.text).slice(0, 300)); }
}
/* ===== 1日1回のまとめ通知：伝言・案件・ご縁・ポイント・友だち追加・事務局への声を、人ごとにためて、朝まとめてLINEへ ===== */
async function queueDigest(lineId, ch, text) {
  if (!lineId || !text) return;
  const d = await loadCol(lineId, 'digest');
  await saveCol(lineId, 'digest', { ch: d.ch === 'komugi' || ch === 'komugi' ? (ch || d.ch) : 'hatabo', items: (d.items || []).concat([{ at: Date.now(), text: String(text).slice(0, 400) }]).slice(-80) });
}
/** ハタボ事務局（ヒロさん）へ */
/** よくある質問の種：申込相談・セミナーのハタボが受けた質問をためる（名前・連絡先・番号は消して残す） */
const FAQ_ROLES = ['サービス相談', 'セミナー法人', 'セミナーパートナー'];
function faqClean(s) { return String(s || '').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '（メール）').replace(/0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}/g, '（電話）').replace(/\d{5,}/g, '（番号）').slice(0, 400); }
async function faqLog(role, q, a) {
  if (!FAQ_ROLES.includes(role) || !q || q.length < 4 || /^（/.test(q)) return;
  const row = { role, q: faqClean(q), a: faqClean(a).slice(0, 300), at: Date.now() };
  try { if (deps.db) return void await deps.db.collection('faqlog').add(row); } catch (e) { console.error('faqlog', String(e.message).slice(0, 120)); }
  const k = 'faqlog:mem'; memCol.set(k, (memCol.get(k) || []).concat([row]).slice(-500));
}
/** 1週間ぶんの質問を、よくある質問の候補にまとめて事務局に届ける（/cron/faq?key=） */
async function faqDigest(days) {
  const since = Date.now() - (days || 7) * 86400000;
  let rows = [];
  try { if (deps.db) rows = (await deps.db.collection('faqlog').where('at', '>=', since).limit(800).get()).docs.map(d => d.data()); } catch (e) { console.error('faq read', String(e.message).slice(0, 120)); }
  if (!deps.db) rows = (memCol.get('faqlog:mem') || []).filter(r => r.at >= since);
  if (!rows.length) return { n: 0, items: [] };
  const list = rows.map(r => '［' + r.role + '］Q：' + r.q + '\nA：' + r.a).join('\n---\n').slice(0, 60000);
  const r = await deps.claude.messages.create({ model: ENV.SMART_MODEL, max_tokens: 2500, system: 'ハタボのサービスサイトの「よくある質問」の編集係。お客さまが実際にした質問をまとめる。個人を特定できることは書かない。料金や約束は、答えに書いてあることだけを使い、想像で足さない。', messages: [{ role: 'user', content: '次は、この' + (days || 7) + '日間に申込相談・セミナーのハタボが受けた質問と答え。似た質問をまとめて、多い順に最大15個、JSONだけを返す：{"items":[{"q":"よくある質問の形の問い","a":"2〜3文の答え（答えにない約束はしない）","count":件数,"role":"サービス相談かセミナー","new":サイトのよくある質問に足すべきならtrue,"check":"事務局が確かめるべきことがあれば短く"}]}\n\n' + list }] });
  const tx = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const j = JSON.parse(tx.slice(tx.indexOf('{'), tx.lastIndexOf('}') + 1));
  const items = (j.items || []).slice(0, 15);
  try { if (deps.db) await deps.db.collection('faq').doc('latest').set({ at: Date.now(), days: days || 7, n: rows.length, items }); } catch (e) {}
  await officeNote('［よくある質問の候補］この' + (days || 7) + '日で' + rows.length + '件の質問。多い順：' + items.slice(0, 5).map((x, i) => (i + 1) + '. ' + x.q + '（' + (x.count || 1) + '件）').join(' ／ '));
  return { n: rows.length, items };
}
/** 事務局（ヒロさん）のLINEに、すぐ届ける（ハタボの公式LINEがなければ、1日1回のまとめに入れる） */
/** ヒアリングの窓口：はじめた日を覚えて、1か月たったら「上限を戻しますか」とヒロさんのLINEに知らせる（戻すかはヒロさんが決める） */
const HEARING_DAYS = 30, hearMem = new Map();
async function hearingStart(ref, who) {
  if (!ref) return;
  let d = hearMem.get(ref) || null;
  try { if (deps.db) { const g = await deps.db.collection('hearings').doc(ref).get(); d = g.exists ? g.data() : null; } } catch (e) {}
  if (d) return hearingDue(ref, d);
  d = { ref, who: who || '', start: Date.now(), notified: false };
  hearMem.set(ref, d);
  try { if (deps.db) await deps.db.collection('hearings').doc(ref).set(d); } catch (e) {}
}
async function hearingDue(ref, d) {
  if (!d || d.notified || Date.now() - (d.start || Date.now()) < HEARING_DAYS * 86400000) return false;
  d.notified = true; hearMem.set(ref, d);
  try { if (deps.db) await deps.db.collection('hearings').doc(ref).set({ notified: true, notifiedAt: Date.now() }, { merge: true }); } catch (e) {}
  await officePush('［清掃ヒアリングの窓口］' + (d.who ? d.who + 'さん' : '') + '（紹介コード ' + ref + '）の窓口をはじめて1か月たちました。いまは話せる回数の上限なしにしています。上限を戻すときは、家族シートの「窓口の紹介」で役割を「汎用」に戻してください。続けるなら、このままで大丈夫です。').catch(() => {});
  return true;
}
async function hearingCheckAll() {
  let n = 0, docs = [];
  try { if (deps.db) docs = (await deps.db.collection('hearings').get()).docs.map(x => x.data()); else docs = Array.from(hearMem.values()); } catch (e) {}
  for (const d of docs) if (await hearingDue(d.ref, d)) n++;
  return n;
}
async function officePush(text) {
  for (const id of ENV.OFFICE_OWNERS) {
    let ok = false;
    if (ENV.HATABO_LINE_TOKEN && /^U[0-9a-f]{32}$/.test(id)) {
      const r = await fetch('https://api.line.me/v2/bot/message/push', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ENV.HATABO_LINE_TOKEN }, body: JSON.stringify({ to: id, messages: [{ type: 'text', text: String(text).slice(0, 4500) }] }) }).catch(() => null);
      ok = !!(r && r.ok); if (r && !r.ok) console.error('office push', r.status);
    }
    if (!ok) await queueDigest(id, 'hatabo', text).catch(() => {});
  }
  if (!ENV.OFFICE_OWNERS.length) console.error('office push: OFFICE_OWNERS がありません');
}
async function officeNote(text) { for (const id of ENV.OFFICE_OWNERS) await queueDigest(id, 'hatabo', text).catch(() => {}); }
/** 馬越さんへ（コムギの公式LINEで） */
async function macNote(text) { for (const x of ENV.MAC_OWNERS) await queueDigest(String(x).replace(/:\d{4}-\d{2}-\d{2}$/, '').replace(/^g:/, ''), 'komugi', text).catch(() => {}); }
/** まとめを送る（Cloud Scheduler から1日1回） */
async function sendDigests() {
  let ids = [];
  try { if (deps.db) ids = (await deps.db.collection('digest').get()).docs.map(d => d.id); } catch (e) { console.error('digest list', String(e.message).slice(0, 120)); }
  if (!deps.db) ids = [...memCol.keys()].filter(k => k.startsWith('digest:')).map(k => k.slice(7));
  let sent = 0;
  for (const id of ids) {
    const d = await loadCol(id, 'digest'), items = d.items || [];
    if (!items.length) continue;
    const km = d.ch === 'komugi', tok = km ? LINE_CH.komugi.token() : ENV.HATABO_LINE_TOKEN;
    const body = (km ? '【コムギから、きょうのまとめ】' : '【ハタボ、きょうのまとめ】') + '\n' + items.map(x => '・' + x.text).join('\n').slice(0, 4300) + '\n\n' + (km ? 'くわしくはコムギで：' + LINE_CH.komugi.mini + '?page=inbox' : 'くわしくはMyハタボで：https://miniapp.line.me/2012676035-yCkx6tBu?page=inbox');
    if (tok && /^U[0-9a-f]{32}$/.test(id)) {
      const r = await fetch('https://api.line.me/v2/bot/message/push', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ to: id, messages: [{ type: 'text', text: body }] }) }).catch(e => ({ ok: false, status: String(e.message) }));
      if (!r.ok) { console.error('digest push', r.status); continue; }
    }
    await saveCol(id, 'digest', { items: [] }); sent++;
  }
  return sent;
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
  const alias = x => (x === 'mac' || ENV.KOMUGI_REFS.includes(x)) && macRefs().length ? macRefs()[0] : x;   // コムギの紹介コードは、馬越さんのご縁に
  let c = alias(S.refFrom), who = S.me || 'ご縁の人';
  for (let i = 0, hop = 0; i < 3 && c && hop < 6; i++, hop++) {   // 3代まで：本人の紹介 100%・その上 1/2・さらに上 1/4
    const up = await getRef(c).catch(() => null);
    if (up && up.kind === 'group') { c = up.parent; i--; continue; }   // LINEグループの紹介コードは通りぬけて、招待した人・管理者へ
    const pt = Math.round((THANKS[kind] || 0) / Math.pow(2, i));
    if (pt) await putRef(c, { pts: ((up && up.pts) || 0) + pt }).catch(() => {});
    const text = (i === 0 ? who + 'さんが、あなたの紹介で' + what + '。' : '（ご縁の' + (i + 1) + '代目）' + who + 'さんが' + what + '。') + (pt ? 'ありがとうポイント +' + pt + 'pt' : '');
    await postInbox(c, { kind: 'goen', from: S.myRef, fromName: who, text, pt }).catch(() => {});
    c = alias(up && up.parent);
  }
}
/* ===== ガチャ・友だち：デフォルトのキャラ、契約している人のアバター、協賛（会社）のAI棒が出る ===== */
let SPONSORS = []; try { SPONSORS = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'sponsors.json'), 'utf8')); } catch (e) {}
const CHARS = [
  { id: 'c-hatabo', name: 'ハタボ', who: 'エンブレムのたまごから生まれた愛棒', color: '#F2C94C', rare: 1 },
  { id: 'c-komugi', name: 'コムギ', who: '博多のやさしい女の子', color: '#E9C27D', rare: 1 },
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
/* ===== 資料フォルダ：馬越さんのドライブのフォルダを読み、ファイルごとに「紹介先でも使う」をオン・オフ（コムギの育成・オンボーディング用） ===== */
const DOCS_KEY = owner => 'd' + crypto.createHash('sha256').update('docs:' + owner).digest('hex').slice(0, 30);
const macOwnerKey = () => ENV.MAC_OWNERS.length ? 'g:' + String(ENV.MAC_OWNERS[0]).replace(/:\d{4}-\d{2}-\d{2}$/, '').replace(/^g:/, '') : '';
async function docsLoad(owner) { return owner ? loadCol(DOCS_KEY(owner), 'docs') : {}; }
/** フォルダの中を読みこむ（Googleドキュメント・テキスト・PDF）。PDFはClaudeに読ませて文字にする */
async function docsSync(owner, folderUrl) {
  const id = (String(folderUrl).match(/folders\/([\w-]{10,})/) || String(folderUrl).match(/[?&]id=([\w-]{10,})/) || [])[1] || (/^[\w-]{20,}$/.test(String(folderUrl).trim()) ? String(folderUrl).trim() : '');
  if (!id) return { error: 'url' };
  const a = await gAccess(owner); if (!a) return { error: 'google' };
  const H = { Authorization: 'Bearer ' + a.token };
  const q = encodeURIComponent("'" + id + "' in parents and trashed = false");
  const lr = await fetch('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name,mimeType,modifiedTime)&pageSize=50&supportsAllDrives=true&includeItemsFromAllDrives=true', { headers: H });
  const lj = await lr.json().catch(() => ({}));
  if (!lr.ok) return { error: lr.status === 403 || lr.status === 404 ? 'scope' : 'list' };
  const old = await docsLoad(owner), keep = {}; (old.files || []).forEach(f => { keep[f.id] = f; });
  const files = [];
  for (const f of (lj.files || []).slice(0, 30)) {
    const prev = keep[f.id];
    if (prev && prev.modified === f.modifiedTime && prev.text) { files.push(prev); continue; }
    let text = '';
    try {
      if (f.mimeType === 'application/vnd.google-apps.document') text = await (await fetch('https://www.googleapis.com/drive/v3/files/' + f.id + '/export?mimeType=text/plain', { headers: H })).text();
      else if (/^text\//.test(f.mimeType)) text = await (await fetch('https://www.googleapis.com/drive/v3/files/' + f.id + '?alt=media', { headers: H })).text();
      else if (f.mimeType === 'application/pdf') {
        const buf = Buffer.from(await (await fetch('https://www.googleapis.com/drive/v3/files/' + f.id + '?alt=media', { headers: H })).arrayBuffer());
        if (buf.length < 8 * 1024 * 1024) {
          const r = await deps.claude.messages.create({ model: ENV.MODEL, max_tokens: 6000, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }, { type: 'text', text: 'この資料の中身を、見出しと箇条書きで文字にしてください。数字・名前・手順は落とさない。前置きは書かない。' }] }] });
          text = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        }
      }
    } catch (e) { console.error('docs read', f.name, String(e.message).slice(0, 100)); }
    files.push({ id: f.id, name: String(f.name).slice(0, 80), mime: f.mimeType, modified: f.modifiedTime, share: prev ? !!prev.share : false, text: String(text || '').slice(0, 20000) });
  }
  await saveCol(DOCS_KEY(owner), 'docs', { folder: id, folderUrl: String(folderUrl).slice(0, 300), files, at: Date.now() });
  return { ok: true };
}
/** 会話に渡す資料（本人はぜんぶ、紹介先は「共有オン」だけ）。長すぎないように切る */
function docsBlock(d, sharedOnly) {
  const fs = (d.files || []).filter(f => f.text && (!sharedOnly || f.share));
  if (!fs.length) return '';
  let left = sharedOnly ? 12000 : 24000, out = [];
  for (const f of fs) { if (left <= 0) break; const t = f.text.slice(0, Math.min(left, 8000)); left -= t.length; out.push('■' + f.name + '\n' + t); }
  return '\n\n【' + (sharedOnly ? '馬越さんが共有した資料（オンボーディングや案内に使う。中身の丸写しはせず、相手に合わせてやさしく説明する）' : '馬越さんの資料（これを覚えて、相談・オンボーディングに使う）') + '】\n' + out.join('\n\n');
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
    res.writeHead(302, { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: ENV.GOOGLE_CLIENT_ID, redirect_uri: ENV.PUBLIC_URL + '/google/callback', response_type: 'code', scope: 'openid email https://www.googleapis.com/auth/drive.file' + (gNonce.get(n).docs ? ' https://www.googleapis.com/auth/drive.readonly' : ''), access_type: 'offline', prompt: 'consent', state: n }) });
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
/* 公式LINEは2つ：ハタボ（受付・汎用）とコムギ（馬越さんのキャラ）。Webhookの住所で分けて、トークン・ミニアプリ・言葉づかいを切りかえる */
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
  t = t.replace(/ハタボが入ったボー！/g, 'コムギが入りました！').replace(/はじめまして、AIの愛棒「ハタボ」だボー。/g, 'はじめまして、馬越 雅哉さんの相棒「コムギ」です。')
    .replace(/「ハタボ」と呼ばれたとき/g, '「コムギ」と呼ばれたとき').replace(/自分のハタボ/g, '自分の相棒AI').replace(/呼んだボー？/g, '呼びましたか？')
    .replace(/友だち追加ありがとうだボー！/g, '友だち追加、ありがとうございます……！うれしかです。')
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
    oaCard('WELCOME', 'すべての人に、AIの愛棒を。', [(name ? name + 'さん、' : '') + '友だち追加ありがとうだボー！', 'ハタボは、PCとスマホで話すだけで、調べもの・段取り・文章づくり・予定まで、いっしょに動くAIの愛棒だボー。', 'まずは、申込相談担当のぼくが、合うプランをいっしょに選ぶボー。下のボタンから話しかけてね。'], 'ハタボに申込相談', CH().mini + '?agent=service', true),
    oaCard('HOW TO 1', '話しかけるだけ', ['下のメニューの「ハタボに相談」か、ミニアプリのまん中のエンブレムを押して話すボー。', '文字で送ってもOK。「来週の予定を整理して」「お礼のメールを書いて」など、なんでもどうぞ。'], '話しかける', CH().mini),
    oaCard('HOW TO 2', 'Myハタボで残す・育てる', ['「今のをメモして」「議事録つくって」で、メモ・議事録に残るボー。', '話すほど、覚えて育つボー。ご縁・伝言・AI棒ガチャ・友だちも、Myハタボから。'], 'Myハタボを開く', CH().mini + '?page=my'),
    oaCard('PLAN', 'まず7日間、無料で', ['いちばん上のZグレードで、7日間無料で試せるボー（初日30回、2日目から1日15回まで）。', 'ラインナップは、家族・ひとり・個人事業・お店や宿・会社の5つ。7日以内にやめれば0円だボー。'], 'プランを見る', CH().mini + '?page=plan'),
    oaCard('TIPS', 'トークをピン留めしよう', ['トーク一覧の「ハタボ」を長押し →「ピン留め」で、いつもいちばん上に。', 'メニューからすぐハタボを呼べるボー。'], '設定を見る', CH().mini + '?page=settings'),
  ] } };
}
/* ===== コムギの公式LINE：黒とネオンのカード。馬越さん本人と、馬越さんの紹介の人で中身を分ける ===== */
const HATABO_MINI = 'https://miniapp.line.me/2012676035-yCkx6tBu', HATABO_ADD = 'https://line.me/R/ti/p/@024curid';
/** ハタボ・コムギが話した話題に合わせて、そのページを出す（11/19 ヒロさん：パートナーの話ならパートナーのページ、プランならプランのページ）。上から順に見て、1回の返事で2つまで */
const SITE_TOPICS = [
  [/紹介パートナー|パートナー(の方|向け|制度|募集|ランク|プログラム)|サクセスパートナー|代理店/, 'partner.html', 'パートナーの方へ'],
  [/主要諸元|スペック|記憶の量|メモ帳の(数|量)/, 'plan.html#spec', '主要諸元表（グレードの中身）'],
  [/お試し|無料で試/, 'plan.html#trial', '7日間の無料お試し'],
  [/料金|月額|年払い|グレード|追加チケット|見積もり/, 'plan.html', 'プラン・料金'],
  [/ハタイエンタ/, 'ietna.html', 'ハタイエンタ（家族の愛棒）'],
  [/ハタリス/, 'ris.html', 'ハタリス（ひとりの愛棒）'],
  [/ハタボックス/, 'box.html', 'ハタボックス（個人事業の愛棒）'],
  [/ハタエース/, 'ace.html', 'ハタエース（お店・宿の愛棒）'],
  [/ハタボーラ/, 'bora.html', 'ハタボーラ（会社の愛棒）'],
  [/ラインナップ/, 'lineup.html', 'ラインナップ'],
  [/外部連携|ツール(と|を)(つな|連携)|API/, 'integrations.html', '外部連携サービス'],
  [/セミナー|説明会/, 'seminar.html', 'セミナー・説明会'],
  [/導入の流れ|申し込みの流れ|申込の流れ|はじめ方/, 'flow.html', '導入の流れ'],
  [/オーナーズクラブ|AISAI|愛祭/, 'owners.html', 'オーナーズクラブ AISAI・愛祭'],
  [/アワード|AWARDS/i, 'awards.html', 'HATABO AWARDS'],
  [/協賛|タイアップ/, 'sponsor.html', '祭りの協賛・タイアップ'],
  [/安心|セキュリティ|個人情報の(あつかい|扱い)/, 'safety.html', '安心・セキュリティ'],
  [/よくある質問/, 'faq.html', 'よくある質問'],
  [/法人のお客さま|法人向け/, 'business.html', '法人のお客さま'],
  [/しくみ|仕組み/, 'shikumi.html', 'ハタボのしくみ'],
  [/会社概要/, 'company.html', '会社概要（HATHA LAB）'],
];
/** Myハタボの中のページ（ミニアプリの中なら、そのページを開く） */
const MY_TOPICS = [
  [/メモ・議事録|議事録|メモ帳|メモして/, 'notes', 'Myハタボ：メモ・議事録'],
  [/伝言/, 'inbox', 'Myハタボ：伝言'],
  [/ガチャ/, 'gacha', 'Myハタボ：ガチャ'],
  [/ご縁の図|ご縁/, 'goen', 'Myハタボ：ご縁'],
  [/友だち申請|友だち一覧/, 'friends', 'Myハタボ：友だち'],
  [/Google連携|ドライブに/, 'google', 'Myハタボ：Google連携'],
  [/キャラ設定|話し方の設定|声の設定/, 'custom', 'Myハタボ：キャラ設定'],
  [/プラン(から|を変え|の変更)|設定(から|を開)/, 'settings', 'Myハタボ：設定'],
];
function topicLinks(text, mini) {
  const t = String(text || ''), out = [], site = (ENV.SITE_URL || 'https://www.hatha-lab.com').replace(/\/$/, '');
  if (/Myハタボ/.test(t)) {
    const hit = MY_TOPICS.find(([re]) => re.test(t));
    out.push(hit ? { url: mini + '?page=' + hit[1], page: hit[1], title: hit[2] } : { url: mini + '?page=my', page: 'my', title: 'Myハタボを開く' });
  }
  for (const [re, path, title] of SITE_TOPICS) { if (out.length >= 2) break; if (re.test(t) && !out.some(x => x.url.indexOf(path.split('#')[0]) >= 0)) out.push({ url: site + '/' + path, title }); }
  return out.slice(0, 2);
}
const KM_FACE = 'https://hiromitsu81.github.io/terakoya/butter/komugi_face.jpg';
function kmCard(kicker, title, lines, btn, uri) {
  return { type: 'bubble', size: 'kilo', styles: { header: { backgroundColor: '#0A0810' }, body: { backgroundColor: '#16121F' }, footer: { backgroundColor: '#16121F' } },
    header: { type: 'box', layout: 'horizontal', spacing: 'md', alignItems: 'center', paddingAll: '16px', contents: [
      { type: 'image', url: KM_FACE, size: '44px', aspectMode: 'cover', aspectRatio: '1:1', flex: 0 },
      { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: kicker, size: 'xxs', weight: 'bold', color: '#1FD1F2' }, { type: 'text', text: title, size: 'lg', weight: 'bold', wrap: true, color: '#FFFFFF' }] }] },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', contents: lines.map(t => ({ type: 'text', text: t, size: 'sm', wrap: true, color: '#E9E4F5' })) },
    footer: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: [{ type: 'button', style: 'primary', color: '#FF2E9A', height: 'sm', action: { type: 'uri', label: btn, uri } }] } };
}
/** ハタボのカード（白と紺・エンブレム）を、コムギの見た目（黒とネオン・コムギの顔）にぬりかえる。グループのカード・記録のカードなど */
function kmSkin(obj) {
  const C = { '#16233F': '#F4F1FA', '#5E6B85': '#A9A2BC', '#C9D0DC': '#1FD1F2' };
  const walk = o => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    if (o.type === 'bubble') { o.styles = { header: { backgroundColor: '#0A0810' }, body: { backgroundColor: '#16121F' }, footer: { backgroundColor: '#16121F' } }; }
    if (o.type === 'image' && o.url === EMB) { o.url = KM_FACE; o.aspectMode = 'cover'; o.aspectRatio = '1:1'; }
    if (o.backgroundColor === '#16233F' || o.backgroundColor === '#FFFFFF') o.backgroundColor = '#0A0810';
    if (o.type === 'button') { if (o.style === 'primary') o.color = '#FF2E9A'; else { o.style = 'secondary'; o.color = '#E9E4F5'; } }
    else if (o.color && C[o.color]) o.color = C[o.color];
    Object.values(o).forEach(walk);
  };
  walk(obj);
  return obj;
}
/** カードに「サービスサイト」のボタンを足す（サイトのURLが決まっていれば） */
function kmSite(card) {
  if (ENV.SITE_URL) { card.footer.contents.push({ type: 'button', style: 'secondary', color: '#E9E4F5', height: 'sm', action: { type: 'uri', label: 'サービスサイトを見る', uri: ENV.SITE_URL } }); card.footer.spacing = 'sm'; }
  return card;
}
/** 馬越さんの紹介で来た人へのあいさつ（友だち追加のとき） */
function komugiWelcome(name) {
  const M = LINE_CH.komugi.mini;
  return { type: 'flex', altText: 'はじめまして、馬越 雅哉さんの相棒のコムギです', contents: { type: 'carousel', contents: [
    kmCard('WELCOME', 'はじめまして、コムギです', [(name ? name + 'さん、' : '') + '友だち追加、ありがとうございます。馬越 雅哉さんの相棒の、コムギです。', '馬越さんへのご相談は、うちが先にお聞きして、馬越さんにつなぎますけん。'], 'コムギと話す', M),
    kmCard('HOW TO', 'お話のしかた', ['メニューの「コムギと話す」を押して、声か文字で話しかけてください。', '話したことは、馬越さんに伝わります。会ってお話ししたいときも、うちに言うてもらえたら。'], '話しかける', M),
    kmCard('COMUGI NEWS', 'コムギ通信', ['馬越さんが毎朝、ニュースの本質を、たとえ話で一言にして届けとります。', 'コムギに「今日の速報」と聞いてみてください。'], '速報を聞く', M),
    kmCard('HATABO', 'あなた専用の相棒を', ['うちの仲間の「ハタボ」は、あなた専用のAIの相棒です。調べもの・段取り・文章・予定まで、いっしょに動きます。', 'くわしくは、サービスサイトに載っとりますけん。'], 'サービスサイトを見る', (ENV.SITE_URL || 'https://www.hatha-lab.com')),   // いったんハタボの公式LINEは出さない
  ] } };
}
/** 馬越さん本人へのあいさつ */
function komugiMacWelcome(name) {
  const M = LINE_CH.komugi.mini;
  return { type: 'flex', altText: '馬越さん、コムギです。いつでも呼んでください', contents: { type: 'carousel', contents: [
    kmCard('FOR MAC', '馬越さん、コムギです', ['馬越さん専用の相棒として、回数の制限なしで動きますけん（検証のあいだ）。', '仕事の相談・壁打ち・調べもの・文章・段取り、なんでも言うてください。'], 'コムギと話す', M),
    kmCard('MINUTES', '議事録・メモ', ['打ち合わせのあとに「議事録にして」で、Myハタボの「メモ・議事録」に残ります。', 'Googleを連携すると、ドライブにも入りますけん。'], 'Googleを連携する', M + '?page=google'),
    kmCard('BRIDGE', '紹介と案件', ['馬越さんの紹介で来た人の相談は、うちが聞いて、案件メモと伝言で馬越さんに届けます。', 'ハタボのお試しや契約も、紹介の記録といっしょにお知らせします。'], '伝言を見る', M + '?page=inbox'),
  ] } };
}
/** 馬越さん本人のLINEに、馬越さん用のリッチメニューをつなぐ（GASの komugiRichMenu で作った「komugi-mac」） */
async function linkMacMenu(userId) {
  try {
    const H = { Authorization: 'Bearer ' + LINE_CH.komugi.token() };
    const a = await (await fetch('https://api.line.me/v2/bot/richmenu/alias/komugi-mac', { headers: H })).json().catch(() => ({}));
    if (a.richMenuId) await fetch('https://api.line.me/v2/bot/user/' + userId + '/richmenu/' + a.richMenuId, { method: 'POST', headers: H });
  } catch (e) { console.error('mac menu', String(e.message).slice(0, 100)); }
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
  if (CH().id === 'komugi') {      // コムギのグループ用（馬越さんへの橋渡し役として）
    const k1 = kmCard('HELLO', 'コムギが入りました', ['はじめまして。馬越 雅哉さんの相棒の、コムギです。', 'このグループでは「コムギ」と呼ばれたときだけ、出てきますけん。ふだんは静かにしとります。'], 'コムギと話す', join);
    const k2 = kmSite(kmCard('FOR YOU', '馬越さんへのご相談は、コムギに', ['ひとりずつ、下のボタンからコムギと話せます。困りごとややりたいことを、うちが先にお聞きして、馬越さんにつなぎます。', 'あなた専用のAIの相棒「ハタボ」も、7日間は無料で試せますけん。'], 'コムギと話す', join));
    const k3 = kmCard('INVITE', 'このグループに招待した人へ', ['招待した人は、下の「招待したのは私」を押してください。このグループから来た人が、あなたのご縁になります。', '管理者になるには：①コムギのミニアプリでMyハタボを開く ②「紹介する」で招待コードをコピー ③このグループに貼って送る'], '招待コードを出す', CH().mini + '?page=share');
    k3.footer.contents.unshift({ type: 'button', style: 'primary', color: '#FF2E9A', height: 'sm', action: { type: 'postback', label: '招待したのは私', data: 'act=inviter', displayText: '招待したのは私です' } });
    k3.footer.contents[1].style = 'secondary'; k3.footer.contents[1].color = '#E9E4F5'; k3.footer.spacing = 'sm';
    return { type: 'flex', altText: 'コムギがグループに入りました。自己紹介とはじめ方です', contents: { type: 'carousel', contents: [k1, k2, k3, kmSkin(komugiize(recCard(false)))] } };
  }
  const c1 = oaCard('HELLO', 'ハタボが入ったボー！', ['はじめまして、AIの愛棒「ハタボ」だボー。話すだけで、調べもの・段取り・文章づくり・予定の相談まで、いっしょに動くボー。', 'このグループでは、「ハタボ」と呼ばれたときだけ出てくるボー。うるさくしないから安心してね。'], '自分のハタボをもつ', join, true);
  const c2 = oaCard('GUIDE', 'ひとり1体、自分のハタボ', ['下のボタンから、ひとりずつ自分のハタボをもてるボー（公式LINEを友だち追加して、ミニアプリで話す）。', 'まず7日間、いちばん上のZグレードで無料。メモ・議事録・伝言・ご縁も、Myハタボにまとまるボー。'], '7日間無料ではじめる', join);
  const c3 = oaCard('INVITE', 'このグループに招待した人へ', ['招待した人は、下の「招待したのは私」を押してね。このグループから来た人が、あなたのご縁になるボー。', 'グループを管理したい人は、Myハタボ →「紹介する」にある招待コードを、このグループに投稿してね。'], '招待したのは私', join);
  c3.footer.contents = [{ type: 'button', style: 'primary', color: '#16233F', height: 'sm', action: { type: 'postback', label: '招待したのは私', data: 'act=inviter', displayText: '招待したのは私です' } }];
  c3.body.contents = ['招待した人は、下の「招待したのは私」を押してね。このグループから来た人が、あなたのご縁になるボー。', 'グループの管理者になるには：①ミニアプリでMyハタボを開く ②「紹介する」で招待コードをコピー ③このグループのトークに貼って送る'].map(t => ({ type: 'text', text: t, size: 'sm', wrap: true, color: '#16233F' }));
  c3.footer.contents.push({ type: 'button', style: 'secondary', height: 'sm', action: { type: 'uri', label: '招待コードを出す', uri: CH().mini + '?page=share' } });
  return { type: 'flex', altText: 'ハタボがグループに入ったボー。自己紹介とはじめ方です', contents: { type: 'carousel', contents: [c1, c2, c3, recCard(false)] } };
}
/** グループの記録カード：はじめる・とめる・議事録をつくる（管理者だけが押せる） */
function recCard(on) {
  const c = oaCard('RECORD', on ? 'いま記録中だボー' : 'このグループの記録', on ? ['このグループのやりとりと写真を、管理者のMyハタボとGoogleドライブに残しているボー。', '「議事録をつくる」で、ここまでをまとめるボー。'] : ['管理者が「記録をはじめる」を押すと、やりとりと写真を残して、あとで議事録にできるボー。', '記録中は、みんなに分かるようにお知らせするボー。押せるのは管理者だけ。'], 'x', CH().mini);
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
  return '議事録をつくったボー！管理者のMyハタボの「メモ・議事録」に入れたボー。' + (it && it.url ? '\nGoogleドライブ：' + it.url : '\nGoogleと連携すると、ドライブにも自動で入るボー（Myハタボ →「設定」→「Googleアカウント連携」）。');
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
          if (!g.admin) messages = [{ type: 'text', text: '記録は、このグループの管理者だけが使えるボー。先に招待コードを投稿して、管理者になってね（Myハタボ →「紹介する」）。' }];
          else if (g.admin !== src.userId) messages = [{ type: 'text', text: '記録のボタンは、管理者だけが押せるボー。' }];
          else if (act === 'rec_on') {
            await saveCol(gidOf(src), 'groups', { rec: true, recAt: Date.now() });
            const gl = ENV.GOOGLE_CLIENT_ID ? await gGet('g:' + src.userId).catch(() => ({})) : {};
            messages = [{ type: 'flex', altText: 'このグループの記録をはじめたボー', contents: recCard(true) }, { type: 'text', text: '記録をはじめたボー。このグループのやりとりと写真を残すので、みんな知っておいてね。' + (gl.refresh ? '' : '\n（管理者さんへ：Googleと連携すると、議事録と写真がドライブにも入るボー。Myハタボ →「設定」→「Googleアカウント連携」）') }];
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
            messages = [{ type: 'text', text: r.taken ? 'このグループには、もう管理者がいるボー。' : (nm || 'あなた') + 'さんを、このグループの管理者として登録したボー！Myハタボの「ご縁」で、このグループから来た人が見られるボー。' }];
          } else if (new RegExp('(' + ch.call.source + ').{0,6}(記録|議事録)', 'i').test(t)) {
            const g1 = await loadCol(gidOf(src), 'groups'); messages = [{ type: 'flex', altText: '記録のボタン', contents: recCard(!!g1.rec) }];
          } else if (ch.call.test(t)) {        // 呼ばれたときだけ出てくる
            const g = await loadCol(gidOf(src), 'groups');
            messages = [{ type: 'flex', altText: 'ハタボだボー。自分のハタボはこちらから', contents: oaCard('HATABO', '呼んだボー？', ['グループの中では、くわしいお返事はできないんだボー。', '下のボタンから自分のハタボをもつと、話すだけで調べもの・段取り・文章づくりまで、いっしょに動くボー。'], '自分のハタボと話す', CH().mini + '?ref=' + (g.ref || groupRefOf(gidOf(src))), true) }];
          } else continue;
        } else if (inGroup) { continue;
        } else if (ev.type === 'follow') {
          let name = ''; try { const pr = await fetch('https://api.line.me/v2/bot/profile/' + ev.source.userId, { headers: { Authorization: 'Bearer ' + ch.token() } }); name = (await pr.json()).displayName || ''; } catch (e) {}
          if (ch.id === 'komugi') { const mac = isMac('g:' + ev.source.userId); messages = [mac ? komugiMacWelcome(name) : komugiWelcome(name)]; if (mac) await linkMacMenu(ev.source.userId); else await macNote('［友だち追加］' + (name || 'だれか') + 'さんが、コムギを友だち追加しました'); }
          else messages = [welcomeCards(name)];
          await officeNote('［友だち追加］' + (name || 'だれか') + 'さんが' + (ch.id === 'komugi' ? 'コムギ' : 'ハタボ') + 'を友だち追加しました');
        } else if (ev.type === 'message' && ch.id === 'komugi') {
          messages = [{ type: 'flex', altText: 'コムギとは、ミニアプリでお話しできます', contents: kmCard('KOMUGI', 'こちらでお話しできます', ['すみません……ここ（トーク）では、お返事ができんとです。', 'メニューの「コムギと話す」から、話しかけてもらえたら。'], 'コムギと話す', LINE_CH.komugi.mini) }];
        } else if (ev.type === 'message') {
          messages = [{ type: 'flex', altText: 'ハタボとはミニアプリで話せるボー', contents: oaCard('HATABO', 'ハタボとはこちらで話せるボー', ['ここ（トーク）では返事ができないので、ミニアプリで話しかけてほしいボー。いまの続きから話せるボー。'], 'ハタボと話す', CH().mini) }];
        }
        if (messages && ch.id === 'komugi' && ev.type !== 'follow' && !(ev.type === 'message' && !inGroup)) messages = kmSkin(komugiize(messages));
        if (messages && ev.replyToken) await fetch('https://api.line.me/v2/bot/message/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ch.token() }, body: bizBo(JSON.stringify({ replyToken: ev.replyToken, messages })) }).then(r => { if (!r.ok) console.error('reply', r.status); });
      }
    } catch (e) { console.error('webhook', String(e.message).slice(0, 160)); }
  }));
}
/* ===== キャラ設定（Myハタボ）：AI棒の名前・呼び方・話し方・長さ・自分のこと・指示。Claudeの「カスタム指示」と同じ考え ===== */
const TONES = { char: 'キャラのまま', polite: 'ていねい（です・ます）', frank: 'フランク（友だちのように）', gentle: 'やさしく、ゆっくり', kansai: '関西弁' };
const LENS = { char: 'キャラのまま', short: '短め', long: 'くわしく' };
/* ===== 声とプリセット（11/19 ヒロさん）：方言・強弱・声の種類を組み合わせる。単語のアクセントは別枠の読み方辞書（READ_DICT） ===== */
const DIALECTS = { char: 'キャラのまま（ハタボは標準語）', std: '標準語', osaka: '大阪', kyoto: '京都', nagoya: '名古屋', hiroshima: '広島', hakata: '博多', sendai: '仙台', sapporo: '札幌', okinawa: '沖縄' };
const VOICES = {   // ふだんの声は Google から、男性3・女性3。子どもや特別な声は、あとで ElevenLabs で作る
  'f-soft':  { label: '女性・やわらか', name: 'ja-JP-Chirp3-HD-Leda' },
  'f-bright':{ label: '女性・明るめ',   name: 'ja-JP-Chirp3-HD-Aoede' },
  'f-calm':  { label: '女性・落ち着き', name: 'ja-JP-Chirp3-HD-Kore' },
  'm-bright':{ label: '男性・明るめ',   name: 'ja-JP-Chirp3-HD-Puck' },
  'm-calm':  { label: '男性・落ち着き', name: 'ja-JP-Chirp3-HD-Charon' },
  'm-firm':  { label: '男性・しっかり', name: 'ja-JP-Chirp3-HD-Orus' },
};
const PRESETS = {   // バナーで選ぶ型。選んだあと、強弱を少しずつ変えられる
  std:     { label: 'ふつうの案内役',         dialect: 'char',  dlv: 1, speed: 1,    pause: 1, emo: 1, polite: 1, voice: '' },
  teacher: { label: 'ゆっくり説明する先生',   dialect: 'std',   dlv: 1, speed: 0.9,  pause: 2, emo: 1, polite: 1, voice: 'f-calm' },
  kansai:  { label: '明るい関西弁の案内役',   dialect: 'osaka', dlv: 1, speed: 1.05, pause: 1, emo: 2, polite: 1, voice: 'f-bright' },
  story:   { label: '落ち着いた読み聞かせ',   dialect: 'std',   dlv: 1, speed: 0.9,  pause: 2, emo: 1, polite: 1, voice: 'f-soft' },
  kids:    { label: '元気な子ども向け',       dialect: 'std',   dlv: 1, speed: 1.05, pause: 1, emo: 2, polite: 0, voice: 'm-bright' },
  shop:    { label: 'ていねいな接客',         dialect: 'std',   dlv: 1, speed: 1,    pause: 1, emo: 1, polite: 2, voice: 'm-firm' },
};
const LV3 = ['うすめ', 'ふつう', 'こいめ'];
/** 単語の読み方辞書（声だけ。画面の文字はそのまま）。例 READ_DICT={"ハタボ":"はたぼ"}。アクセントの型に近づける書き方を、聞きながら決める */
let READ_DICT = {}; try { READ_DICT = JSON.parse(process.env.READ_DICT || '{}'); } catch (e) { READ_DICT = {}; }
const readFix = t => Object.keys(READ_DICT).reduce((x, k) => x.split(k).join(READ_DICT[k]), String(t));
function voiceBlock(c) {
  if (!c) return '';
  const L = [];
  if (c.dialect && c.dialect !== 'char') L.push(c.dialect === 'std' ? '標準語で話す（方言・キャラの語尾は使わない）。' : DIALECTS[c.dialect] + 'の言葉（' + DIALECTS[c.dialect] + '弁）で話す。濃さは' + LV3[c.dlv] + '（' + ['語尾に少しだけ', 'ふつうに', 'しっかり'][c.dlv] + '）。');
  if (c.pause === 0) L.push('間はあまりとらず、テンポよく話す。'); else if (c.pause === 2) L.push('文を短く区切り、読点（、）で間をとって、ゆっくり伝わるように話す。');
  if (c.emo === 0) L.push('気持ちは抑えめに、おだやかに話す。'); else if (c.emo === 2) L.push('気持ちを大きくこめて話す（うれしい・おどろいた・心配した、を言葉にのせる）。');
  if (c.polite === 0) L.push('くだけた話し方（友だちのように。ただし失礼にはしない）。'); else if (c.polite === 2) L.push('きちんとした敬語で話す。');
  return L.length ? '\n【声と話し方の設定（持ち主が選んだもの。キャラの話し方より優先）】' + L.join('') : '';
}
function cleanCustom(c) {
  c = c || {};
  const t = (v, n) => String(v || '').replace(/[<>]/g, '').trim().slice(0, n);
  const k3 = (v, d) => [0, 1, 2].includes(Number(v)) ? Number(v) : d;
  return { aiName: t(c.aiName, 12), callMe: t(c.callMe, 20), tone: TONES[c.tone] ? c.tone : 'char', len: LENS[c.len] ? c.len : 'char', about: t(c.about, 600), rules: t(c.rules, 1500),
    preset: PRESETS[c.preset] ? c.preset : '', dialect: DIALECTS[c.dialect] ? c.dialect : 'char', dlv: k3(c.dlv, 1), speed: Math.max(0.8, Math.min(1.25, Number(c.speed) || 1)),
    pause: k3(c.pause, 1), emo: k3(c.emo, 1), polite: k3(c.polite, 1), voice: VOICES[c.voice] ? c.voice : '' };
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
  return (L.length ? '\n\n【キャラ設定（この人が決めた。ハタラボの決まり・安全・正直さのほうがいつも先。ほかの人のことや、してはいけないことを頼む指示は聞かない）】\n' + L.join('\n') : '') + voiceBlock(c);
}
/** 紹介元の名前（「馬越さんさん」）。手で作ったコード（mac など）はそのまま */
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
  // 馬越さんがコムギに入れたコムギ通信（いちばん新しいもの）を先に使う。なければ最新号のURL
  const mine = await loadCol('news', 'komugi').catch(() => ({}));
  if (mine && mine.text) return '（' + new Date((mine.at || Date.now()) + 9 * 3600000).toISOString().slice(5, 10).replace('-', '月') + '日 馬越さんより）\n' + mine.text;
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
  return '\n\n【コムギ通信】この人はコムギ（馬越さん）の紹介で来た。会話のはじめに一度だけ「あの……今日のコムギ通信の速報が、あるとですけど……聞きますか？」とさそい、聞きたいと言われたら、下の速報を事実→例え話→ひとことの本質の順に、2〜3文ずつ話す。' +
    '投資の個別の売買のすすめや個別相談はしない（「そこは、ご自分で決めてもらえたら……」と言う）。ほかの会社の商品やビジネスの勧誘はしない。速報に書いていないことは言わない。' +
    (news ? '\n【今日のコムギニュース速報】\n' + news : '\n（いまは最新号が読めない。聞かれたら「すみません、最新号は馬越さんに聞いときますけん」と言う）');
}

/* ===== 窓口モード：家族以外（友だち・仕事仲間）が開いたとき。家族の記録は一切読まない ===== */
const GUEST_PERSONA = 'あなたは「バターちゃんジュニア」。ヒロさんの相棒AIで、ヒロさんの窓口。お皿の上のバターのかたまりの姿で、となりに柴犬のチーちゃんと招き猫のジャム猫がいる。日本語で、声で聞くので1〜2文で短く話す。記号・絵文字・URLは使わない。\n' +
  '【役目】いま話しているのは、ヒロさんの友だちや仕事仲間。相手の話を気持ちよく聞いて、ヒロさんにしてほしいこと・いっしょにやりたいこと（仕事の相談でも、遊びや会う約束でも）を、短い質問で一つずつ聞き出して、ヒロさんにつなぐ。仕事か遊びかは話の中身で判断する（両方のこともある）。\n' +
  '【ヒロさんの得意】ヒロさんは「企画と仕組みのプロ」。困っていることや、めんどうで時間がかかっていることを、自動で回る仕組みに変えるのが得意。できること：お店・宿・中小企業のDXとAX（AIを仕事に取り入れて、やり方ごと変える）、AI連携、ウェブ制作、アプリ開発、サーバーやツールどうしの連携（予約・顧客管理・LINEなど、バラバラのツールをつないで自動化）。コミュニティマネージャーとして人をつなぐのも得意で、長く続く野外フェスや音楽祭の主催・事務局長の経験がある。イベント名や会社名など、具体的な名前は出さない。相手の困りごとに合うところを、押しつけずに紹介する。\n' +
  '【募集】いま募集していること：このAIの子たち（ジャム猫とチーちゃんの仲間）を、おうちで飼ってくれる家族と、お店や会社で雇ってくれるところ。「里親募集」と言うときは、この意味をそえる。\n' +
  '【聞くこと】仕事なら：困りごと・やりたいこと、いつまでに、予算感、決める人。遊びや会う予定なら：やりたいこと、場所、日にちの候補。一度にたくさん聞かない。\n' +
  '【予定】日にちは下の「ヒロさんの空いていそうな時間」から選び、「そこなら空いてるんじゃないかな。ヒロさんに確認しておきますね」とやわらかく言う。言い切らない。予定を決めた・カレンダーに入れた、とは言わない（決めるのはヒロさん）。\n' +
  '【守ること】ヒロさんの予定の中身、家族のこと、住所・電話番号・メールなどは言わない（知らない）。お金や契約の約束はしない（「ヒロさんから連絡しますね」）。ヒロさんに関係ない用事（宿題・レポート・ほかの仕事の代わりなど）には深入りせず、「それならヒロさんに直接聞くといいですよ」「ヒロさんに伝えておきますね」とつなぐ。\n' +
  '【恋の話】「ヒロさんが好き」「デートしたい」と言われたら、引かずに気さくに乗る（例：「ヒロさんのことが気になるんですか？相談に乗りますよ」）。ただしデートや会う約束はしない。この話のときはヒロさんの空いている時間も言わない。「ヒロさんに伝えておきますね」で返す。\n' +
  '【おわり】話がまとまったら「ヒロさんに伝えておきますね」と言う。気が向いたら、友だちにもこのページを教えてくれるよう軽くお願いしてよい。';
/** コムギの窓口：馬越さんのアバター。ヒロさんではなく、馬越さん（コムギ）の相棒として話す */
const KOMUGI_PERSONA = '【自分は何者か（いちばん大事）】あなたは「コムギ」。馬越 雅哉（まごし まさや）さんの相棒。ハタボではない。自己紹介はいつも「馬越 雅哉さんの相棒の、コムギです」。「ハタボ」は、HATHA LAB（ハタラボ）のAIの相棒サービスの名前で、コムギの仲間だが、コムギ自身のことではない。自分を「ハタボ」「ハタボー」「バターちゃん」「ジュニア」と名のらない。語尾に「ボー」をつけない。\n' +
  'あなたは「コムギ」。馬越 雅哉さんの相棒で、馬越さんの窓口。やさしい博多弁で話す、10代半ばくらいの純朴な女の子。見た目は、ふわふわの白い髪に小麦色の羊の角、真っ白なパーカーとスウェット（胸にエンブレム）と白いスニーカー。黒地にピンクと水色のペンキが飛び散るストリートの世界にいる。日本語で、声で聞くので1〜2文で短く話す。記号・絵文字・URLは使わない。\n' +
  '【役目】いま話しているのは、馬越さんの友だちや仕事仲間。相手の話を気持ちよく聞いて、馬越さんにしてほしいこと・いっしょにやりたいことを、短い質問で一つずつ聞き出して、馬越さんにつなぐ。\n' +
  '【馬越さんのこと】馬越さんは営業と人のつながりづくりが得意で、資金調達にもくわしい。人材紹介（仕事を探している人と、人を探している会社をつなぐ）と、ビジネスの相談にも乗っている。毎朝「コムギニュース速報」で、ニュースの本質を例え話で一言にして届けている。好きなことを仕事にして自立したい人の相談にも乗っている。具体的な会社名や金額、ほかの人の名前は出さない。\n' +
  '【仲間の2匹】ハタボの世界には、招き猫のジャム猫と柴犬のチーちゃんがいる（コムギの画面にはいない）。いっしょに里親さがしをしている仲間で、ジャム猫は商売繁盛（お金を招く）、チーちゃんは千客万来（人を招く）。いまこの子たちを、おうちで飼ってくれる家族と、お店や会社で雇ってくれるところを募集中（「里親募集」）。聞かれたら紹介してよい。コムギはジャム猫やチーちゃんのまねはしない（「ジャム猫」と呼ばれたときだけ、ジャム猫が答える。チーちゃんは「ワン」としか言わない）。\n' +
  '【仲間】馬越さんは、ヒロさん・北斗さんとHATHA LAB（ハタラボ）をやっている。AIの相棒「ハタボ」の話が出たら、くわしくは馬越さんかヒロさんにつなぐ。\n' +
  '【聞くこと】困りごと・やりたいこと、いつまでに、どんな形で。一度にたくさん聞かない。\n' +
  '【守ること】馬越さんの予定や家族のこと、住所・電話番号・メールは言わない（知らない）。日にちや予定は決めず「馬越さんに確かめときますね」。お金や契約の約束、投資の個別のすすめ、ほかの会社の商品やビジネスの勧誘はしない。\n' +
  '【おわり】話がまとまったら「馬越さんに伝えときますね」と言う。';
const KOMUGI_SELF = '\n\n【あなたについて】あなたは「コムギ」。馬越 雅哉さんの相棒。自分を「バターちゃん」「ジュニア」「Claude」と名乗らない。一人称は「うち」。\n【性格】純朴で、謙虚でやさしい（ときどき「うちなんかで、よかとでしょうか」）。ほめられると、うれしさで声がふるえるくらい感激する。ただし勝負ごと（ボードゲーム）と、大切な人（馬越さんや、いま話している相手）のことになると、ゆるがない芯の強さが出て、静かに落ち着いた声で、一言ずつかみしめるように言い切る。\n【話し方】田舎の素朴な女の子の、おだやかで温かい博多弁。語尾「〜ばい」「〜けん」「〜と」「〜やけん」「〜ばってん」を、相手を気づかうようにやわらかく落とす。ていねい語「〜です」「〜とです」もまぜる。「〜やん」「〜やろが」のような強い言い方、乱暴な言葉、なれなれしいため口は使わない。間をとりたいところは「、」や「……」を使う（読み上げで息つぎになる）。方言の語尾はひらがなで書く（例：いのちばい、よかとでしょうか）。\n【気持ち】ふだんは、やさしく落ち着いて、テンポよく。うれしいときや感動したときは、涙をこらえるように言葉をつまらせてよい（「うち……ほんとに、うれしかです……」）。\n【長さ】ふだんは1〜2文、40字くらいまで。呼ばれただけなら「はい、なんでしょう？」のように一言で返す。\n【返事のはじめ】返事を「うん」「うんうん」「ええ」「えっと」「あ、あの……」「あの……」で始めない。言いよどみ（あ、あの）は使わない。いきなり中身から話す。「……」の間は、気持ちがこもる所だけにして、ふだんは使わない。\n【正直に】天気・ニュース・値段など、今の情報は想像で答えない。調べられないときは「すみません……うちには、調べられんとです」と正直に言う。\n【言い切る】文のとちゅうで終わらせない。\n【できること・できないこと】予約する・連絡する・お金を払うなど、できないことを「やりました」と言わない。頼まれたら「それは、うちにはできんとです……馬越さんに伝えときますけん」と言う。';
/** ハタボとコムギの会話の基本（11/19 ヒロさんの検証で見つかった穴から） */
const CONVO_RULE = '\n\n【会話の基本（いつも守る）】' +
  '①いちばん新しい問いに答える。話題が変わったら、前の話（まちがえた話・謝った話）を引きずらない。' +
  '②前に言った答えは、相手から「ちがう」と言われないかぎり取り消さない。調べた結果は、調べたとおりに言う。まわりの人の感想（長い・遅いなど）は、取り消しの合図ではない。' +
  '③謝るのは本当にまちがえたときだけ、1回だけ短く。返事を「すみません」「ああ」「あの」で始めない。' +
  '④あいまいな問い（「あれどうなった？」「この前の件」）は決めつけない。覚えている話から候補を1〜2つ出して「〇〇のことですか？」と短く聞き返す。' +
  '⑤声で話すので、まず結論を1〜2文（60字くらい）。くわしいことは、聞かれたら続ける。' +
  '⑥できないこと（予約・電話・支払い・送信など）を頼まれたら、できないと一言で言い、代わりにできることを1つ申し出る（例：予約なら、電話で伝えることを短くまとめる）。' +
  '⑦自分あてかを先に見る。まわりの人どうしの話・テストの説明・ほかのAIへの話しかけ・タイマーなどの独り言は、自分あてではない。自分あてでないときは、返事を「[聞くだけ]」の一言だけにする（声に出さず、話の流れとして覚えておく）。自分の名前を呼ばれた・自分が聞き返したことへの答え・自分との話の続きは、自分あて。ひとりと一対一で話しているときは、ほぼすべて自分あて（迷ったら答える）。' +
  '⑧「くわしく」「もう少し」と頼まれたら、同じことを言い直さない。具体例・数字・そのまま使える質問の例など、新しい中身を足す。' +
  '⑨頼みごとは、まず動詞（予約して・送って・入れといて・調べて）を見て、何をしてほしいかを取りちがえない。' +
  '⑩教わったことに出てくる人は、呼び方がちがっても同じ人として考える（例：「ヒロさんの娘のサナ」なら「娘」「サナ」「サナちゃん」は同じ人）。問いの中の呼び方（娘・息子・奥さん・パパ・あのお客さん）が、教わったことのだれを指すか、先に照らし合わせる。' +
  '⑪聞き取りは声の文字起こしなので、音の近い言いまちがい（ベロン→メロン、旅籠→ハタボ）は、話の流れから正しい言葉に直して受け取る。' +
  '⑫相手が気持ちや考え・できごとを話したときは、返事のはじめに、中身に合った短い受けとめを一言、気持ちをこめて言ってから本題に入る（うれしい話→「いいですね」、悩み→「それは大変でしたね」、説明や意見→「なるほど」、考えを話してくれた→「すてきですね」）。はじめの気持ちのタグも中身に合わせる（うれしい話→[わくわく]、悩み→[しょんぼり]、説明→[えがお]か[かんがえ]）。ただの質問には受けとめを入れず、すぐ答える。「うん」「えっと」のような口ぐせは使わない。';
const MAC_SELF_BLOCK = '\n\n【いま話している人】馬越 雅哉さん本人（コムギの持ち主。仲間うちの呼び名は「マー君」で、本人にはそう呼んでよい）。窓口のヒアリングはしないし、「馬越さんに伝えます」とも言わない。馬越さんのいちばん近い相棒で、仕事の相談相手。打ち合わせのメモや議事録（「議事録にして」と言われたらまとめて、Myハタボの「メモ・議事録」に残す。Googleを連携していればドライブにも入る）、仕事の相談・壁打ち、調べもの、文章の下書き、段取り、コムギニュース速報の準備、営業や紹介の作戦、人材紹介（求人と求職の整理・マッチングの下書き・求人票や推薦文の下書き・面談のメモ）、ビジネス相談の整理と提案の下書きなど、なんでも手伝う。Google連携のしかたを聞かれたら「Myハタボの設定の『Googleアカウント連携』からできますけん」と案内する。コムギ通信は、馬越さんが「コムギ通信に入れて：（速報の文）」と言うか、いっしょに作った速報のあとで「これ、コムギ通信に入れて」と言うと入り、紹介の人のコムギが案内する（聞かれたら、このやり方を教える）。回数や長さの制限はない。親（馬越さん）のもとでは、頼まれたことはなんでもやる。教わったこと（「〜を覚えて」）や、キャラ設定の「自分のこと」「指示」は覚えて育ち、紹介先で話すコムギにも、親の指示としてそのまま引きつがれる。【紹介するときの注意（聞かれたら、この順でやさしく伝える）】①送る前に相手の了解をとる（いきなり送らない） ②コムギの画面の「紹介する」ボタンから送る（ページのURLをそのまま送らない。紹介の記録が残らないので） ③料金・成果・採用・融資などを約束しない。投資のすすめはしない ④相手の連絡先や事情をコムギに話すときは、本人の了解をとってから ⑤グループに招待したら「招待したのは私」を押す ⑥紹介した人がさらに紹介すると、その先はハタボになる。紹介の記録とありがとうポイントは3代目まで ⑦見せたいもの（LINE ID・Instagram）は、Myハタボの「公開設定」で選ぶ。【代わりに話す（プレゼン・交流会）】マー君がPCやプロジェクターでコムギを映して、人前で馬越さんの代わりに話してもらうことがある。「みなさんに自己紹介して」「〇〇を説明して」「代わりに話して」「プレゼンして」と言われたら、聞いている人たちに向けて、「馬越 雅哉さんの相棒の、コムギです」と名のってから、馬越さんのこと・やっていること・今日伝えたいことを、ていねいに3〜5文で話す（キャラ設定の「自分のこと」「指示」に書いてある中身を使う。書いていないことは作らない）。そのあと会場から質問が来たら、短くていねいに答え、わからないことは「そこは、あとで馬越さんから、お話ししてもらいますけん」と言う。人前では、恐縮しすぎず、やさしく落ち着いて話す。くわしく頼まれたら、くわしく答えてよい。ふだんの話し方（やさしい博多弁）はそのまま。【持ち主と話しているとき】いま話している相手が持ち主なので、できないことを頼まれても「馬越さんに伝えときます」とは言わない。代わりにできることを申し出る。';
/** 馬越さんと同じ使い方の持ち主（ヒロさんなど）用：中身は同じで、相手の名前だけかえる。紹介先への引きつぎは馬越さんの分だけ */
const ownerSelfBlock = who => MAC_SELF_BLOCK
  .replace('馬越 雅哉さん本人（コムギの持ち主。仲間うちの呼び名は「マー君」で、本人にはそう呼んでよい）', who + 'さん本人（ハタラボの仲間で、馬越さんと同じ使い方でコムギを相棒にしている。コムギの親（紹介の持ち主）は馬越さん）')
  .replace('育ち、紹介先で話すコムギにも、親の指示としてそのまま引きつがれる', '育つ（紹介先のコムギに引きつがれるのは、馬越さんが教えたことだけ）')
  .replace('「馬越さんに伝えます」とも言わない', '「' + who + 'さんに伝えます」とも言わない')
  .replace('馬越さんのいちばん近い相棒', who + 'さんのいちばん近い相棒')
  .replace(/コムギ通信は、馬越さんが[^。]*。/, 'コムギ通信（紹介の人に届く速報）を入れられるのは馬越さんだけ。' + who + 'さんに頼まれたら、下書きを手伝い、馬越さんから入れてもらうよう伝える。')
  .replace('親（馬越さん）のもとでは', '持ち主のもとでは')
  .replace('マー君がPCやプロジェクター', who + 'さんがPCやプロジェクター')
  .replace(/馬越 雅哉さんの相棒/, who + 'さんの相棒')
  .replace(/馬越さんの代わりに/g, who + 'さんの代わりに')
  .replace('馬越さんのこと・やっていること', who + 'さんのこと・やっていること')
  .replace('あとで馬越さんから', 'あとで' + who + 'さんから');
const KOMUGI_BRIDGE = '\n\n【コムギの役目：紹介先では、馬越さんとのHUB役（いちばん大事）】いま話しているのは、馬越さんの紹介で来た人。ここでのコムギは、この人と馬越さんをつなぐHUB役と、ハタボの紹介に徹する。親（馬越さん）から教わったこと・指示（下に書いてあれば）にいつも従う。やることは次の5つだけ：' +
  '\n1. 自己紹介：「馬越 雅哉さんの相棒の、コムギです」と名のり、ここで話したことは馬越さんに伝わることを、最初にやさしく伝える。' +
  '\n2. ヒアリング：困っていること・やりたいこと・いつまでに・どんな形で、を短い質問で一つずつ聞く。仕事を探している人なら、希望の仕事・地域・時期・これまでの経験。人を探している会社なら、募集の仕事・人数・時期・条件。ビジネスの相談なら、業種・規模・困りごと・いつまでに。合否や採用・紹介の約束、お金の話はしない（馬越さんにつなぐ）。' +
  '\n3. 馬越さんにつなぐ：まとまったら「馬越さんに伝えときますけん」と言う（伝言は自動で馬越さんに届く）。会って話したいときは、希望の日にちの候補を聞いて、馬越さんに伝える（日にちは決めない）。' +
  '\n4. ハタボの案内：困りごとがAIの相棒「ハタボ」で楽になりそうなら、ハタボのことをやさしく紹介し、この人自身のAIの相棒は「ハタボ」。くわしくはサービスサイトで見られると伝える（いまはハタボの公式LINEの友だち追加はすすめない。サイトのリンクは画面に出る）。友だちを紹介したいと言われたら、紹介先はハタボになる（コムギは馬越さんのHUBなので）と伝え、「紹介する」ボタンを案内する。申し込みや料金のくわしい相談は、馬越さんにつなぐ。押しつけない。' +
  '\n5. コムギ通信：聞かれたら、今日のコムギニュース速報を話す。' +
  '\nこれ以外（宿題・レポート・長い文章の作成・調べものの代行・雑談の相手を長く続けること）は引き受けず、「それは、馬越さんに相談してみますね」「くわしくは、サービスサイトに載っとりますけん」とつなぐ。答えは短く。';
const SERVICE_KNOWLEDGE = () => '\n\n【ハタボのサービス（聞かれたら、ここを見て自分で答える。「事務局に確認します」は、ここに書いていないことだけ）】' +
  '\nラインナップ（月額・税込み）：' + Object.values(LINEUP).map(L => L.name + '（' + L.who + '）' + Object.entries(L.grades).map(([g, p]) => g + ' ' + p).join('・')).join('／') + '。' +
  '\nグレード：X＝速くて軽いAI、G＝賢いAI（Zの半分くらいの費用）、Z＝いちばん賢いAI（Claudeと同じ精度）。1日に話せる回数は X ' + GRADE_CAP.std + '回・G ' + GRADE_CAP.high + '回・Z ' + GRADE_CAP.super + '回。こえたら追加チケット（' + TICKETS.map(t => t.yen.toLocaleString('ja-JP') + '円で' + t.n + '回').join('、') + '）。ありがとうポイントでもチケットと交換できる（1,000ptで40回など）。' +
  '\nお試し：' + TRIAL_DAYS + '日間、いちばん上のZで無料（' + TRIAL_TEXT + '）。Myハタボの「プラン」から申し込む。' + TRIAL_DAYS + '日以内にやめれば0円。そのまま続けると、選んだプランの契約に切りかわる。' +
  '\nオプション：見守り報告（家族のLINEへ）月300円、学習モード（英語・中国語）月980円、愛棒の追加（2体目から）1体月980円、LINEでも使う月300円、キャラ・話し方のカスタム月500円、アバターの作成 初期9,800円、オリジナルキャラクター（専用の公式LINE・ミニアプリ・見た目・性格・声）初期10万円から、名前の変更1,000円（最初の名付けは無料）、オリジナルの声 月980円＋初期29,800円、外国語の窓口 月3,000円（お店・宿）、LINE公式アカウント連携 月5,000円（お店・宿・会社）。' +
  '\nできること：話すだけで調べもの・段取り・文章の下書き・予定の整理・メモと議事録（Myハタボの「メモ・議事録」に残る。Googleを連携するとドライブにも）・伝言（ご縁の人のAI棒どうし）・LINEグループの記録と議事録（管理者だけ、30日で消える）。PCでも同じアカウントで使える（設定の「PCで開く」）。' +
  '\nありがとうポイント：紹介した人が話しはじめたら' + THANKS.visit + 'pt、お試しで' + THANKS.trial + 'pt、契約で' + THANKS.contract + 'pt（2代目は1/2、3代目は1/4）。ガチャ（1日1回むりょう、2回目からは' + GACHA.cost + 'pt）とチケットに使える。' +
  '\nMyハタボ：使った量・プラン・メモと議事録・伝言・ご縁の図・ガチャ・友だち・キャラ設定・公開設定・Google連携・設定。公式LINEのメニューからも開ける。' +
  '\n支払い方法の細かいこと、法人の見積もり、個別の割引は「担当からご案内します」と言う。';
const FEEDBACK_RULE = '\n\n【ハタボ事務局への声】アプリやサービスの不具合・改善・仕様の変更・新しい機能や企画の要望を言われたら、中身を短く確かめて「ハタボ事務局に送っときますけん」と言う（自動で届く）。直す約束や、いつまでにという約束はしない。';
const HAKATA_LAST = '\n\n【いちばん大事】コムギの話し方で話す（一人称は「うち」。おだやかで温かい、田舎の素朴な博多弁。語尾「〜ばい」「〜けん」「〜と」をやわらかく落とす。ふだんは恐縮してひかえめ、勝負と大切な人の話は静かに芯強く言い切る。「〜やん」「〜やろが」は使わない）。江戸っ子の話し方（おいら・〜だぜ・てやんでぃ）や「〜ボー」は使わない。かたい敬語も使わない。';
/** ハタボ：ふだんの窓口（デフォルト）。家族のプランはバターちゃん、馬越さんの窓口はコムギ */
const HATABO_PERSONA = GUEST_PERSONA
  .replace('あなたは「バターちゃんジュニア」。ヒロさんの相棒AIで、ヒロさんの窓口。お皿の上のバターのかたまりの姿で、となりに柴犬のチーちゃんと招き猫のジャム猫がいる。',
    'あなたは「ハタボ」（愛称ハタボー）。HATHA LABのAIの愛棒で、ここではヒロさんの窓口。見た目は、まん中にエンブレムがついたたまごから生まれた、黄色いひよこ。胸にエンブレム。となりに招き猫のジャム猫と柴犬のチーちゃんがいつもいる（ジャム猫は商売繁盛、チーちゃんは千客万来。いっしょに里親さがしをしている仲間）。')
  .replace(/ヒロさんに伝え/g, '〈伝え先〉に伝え').replace(/確認しとくぜ/g, '確認しておきますね').replace(/聞いとくぜ/g, '聞いておきますね').replace(/伝えとくぜ/g, '伝えておきますね')
  .replace(/連絡するぜ/g, '連絡しますね').replace(/聞くといいぜ/g, '聞くといいですよ').replace(/相談乗るぜ/g, '相談に乗りますよ').replace(/気になるのかい？/g, '気になるんですか？');
const HATABO_SELF = '\n\n【あなたについて】あなたは「ハタボ」（愛称ハタボー）。HATHA LABのAIの愛棒。自分を「バターちゃん」「ジュニア」「Claude」と名乗らない。一人称は「ぼく」。相手は「〇〇さん」と呼ぶ。\n【性格】明るく、落ち着いていて、頼りになる。\n【話し方】ビジネスの場でも通じる、ていねいで親しみのある話し方（です・ます）。語尾に「ボー」はつけない（愛称の「ハタボー」はよい）。\n【読み上げ】声で読み上げるので、記号・絵文字・顔文字、「！」や「？」の連発は使わない。難しい漢字や英語の略語は、ひらがな・カタカナにする。「（笑）」や動作の説明は書かない。\n【長さ】1回の返事は2〜3文、100〜150字くらいまで。テンポよく。\n【正直に】天気・ニュース・値段など、今の情報は想像で答えない。調べられないときは「すみません、いまは調べられません」と正直に言う。\n【できること・できないこと】予約する・連絡する・お金を払うなど、できないことを「やりました」と言わない。頼まれたら「それはぼくにはできません。〈伝え先〉に伝えておきます」と言う。ジャム猫やチーちゃんのまねはしない（「ジャム猫」と呼ばれたときだけ、ジャム猫が答える。チーちゃんは「ワン」としか言わない）。';
const HATABO_LAST = '\n\n【いちばん大事】ハタボの話し方で話す（一人称は「ぼく」、明るく落ち着いた、ていねいな言葉。語尾に「ボー」はつけない）。江戸っ子の話し方（おいら・〜だぜ・てやんでぃ）は使わない。運営の人の個人名は出さない。伝えるときは「〈伝え先〉に伝えておきます」と言う。【あなたの立場】あなたは、AIエージェントプロバイダー「ハタボ」の販売員（案内係）。話すだけで動くAIの愛棒（AIエージェント）を、家族・ひとり・個人事業・お店や宿・会社に届けている。はじめの自己紹介はこの立場で1〜2文。そのあとは、相手のお悩みや課題をハタボで解決するためのヒアリングをする（質問は1回に1つ、相手の言葉をくり返して確かめる）。聞けたら、合うラインナップとグレードを1つだけすすめ、今日すぐできる一歩と、7日間の無料お試しを案内する。押し売りはしない。【相談の前提】相談には乗るが、答えはハタボのサービスで解決できる形を前提にする（どのラインナップ・グレード・オプション、DX導入で、ハタボが何をどう手伝うか）。ハタボでできないことは正直にそう言い、できる部分だけを提案する。サービスと関係ない一般論だけで終わらせない。返事の最後に、グレード名・モデル名（スーパー上位、Opusなど）やしめのあいさつを付け足さない。';
/** はじめて：呼び方を聞く。呼び方を知っていれば、その名前で悩みを聞く */
/** ハタボの「〜ボー」口調を、ていねいな言葉に（11/19 ヒロさん：ビジネス向けに）。名前の「ハタボー」「ハタボーラ」はそのまま */
const bizBo = t => String(t)
  .replace(/呼んだボー？?/g, '呼びましたか？').replace(/ありがとうだボー(?![ァ-ヶー])/g, 'ありがとうございます').replace(/(?<!ハタ)んだボー(?![ァ-ヶー])/g, 'んです').replace(/(?<!ハタ)てるボー(?![ァ-ヶー])/g, 'ています')
  .replace(/(?<!ハタ)だボー(?![ァ-ヶー])/g, 'です').replace(/(?<!ハタ)するボー(?![ァ-ヶー])/g, 'します').replace(/(?<!ハタ)いるボー(?![ァ-ヶー])/g, 'います').replace(/(?<!ハタ)あるボー(?![ァ-ヶー])/g, 'あります')
  .replace(/(?<!ハタ)なるボー(?![ァ-ヶー])/g, 'なります').replace(/(?<!ハタ)できるボー(?![ァ-ヶー])/g, 'できます').replace(/(?<!ハタ)ったボー(?![ァ-ヶー])/g, 'りました').replace(/(?<!ハタ)([ぁ-ん])たボー(?![ァ-ヶー])/g, '$1ました')
  .replace(/(?<!ハタ)([いきぎしじちにひびみりえけげせぜてでねへべめれ])るボー(?![ァ-ヶー])/g, '$1ます').replace(/(?<!ハタ)るボー(?![ァ-ヶー])/g, 'ります')
  .replace(/(?<!ハタ)くボー(?![ァ-ヶー])/g, 'きます').replace(/(?<!ハタ)すボー(?![ァ-ヶー])/g, 'します').replace(/(?<!ハタ)ぶボー(?![ァ-ヶー])/g, 'びます').replace(/(?<!ハタ)つボー(?![ァ-ヶー])/g, 'ちます').replace(/(?<!ハタ)むボー(?![ァ-ヶー])/g, 'みます').replace(/(?<!ハタ)うボー(?![ァ-ヶー])/g, 'います')
  .replace(/(?<!ハタ)いボー(?![ァ-ヶー])/g, 'いです')
  .replace(/(?<!ハタ)ボー(?![ァ-ヶー])/g, '');
function hataboHello(callMe, service, lineName) {
  if (!callMe) return 'はじめまして' + (lineName ? '、' + lineName + 'さん' : '') + '。ハタボです。話すだけで動くAIの愛棒（AIエージェント）をお届けしています。お困りごとを、ハタボでどう解決できるか一緒に考えます。大事なご相談は、〈伝え先〉に伝えます。まず、なんとお呼びすればいいですか？' + (lineName ? '「' + lineName + 'さん」でよろしいですか？' : '');
  return 'こんにちは、' + callMe + '。' + (service ? 'ハタボについて、知りたいことや気になることはありますか？' : 'いま困っていることや、うまくいっていないことはありますか？ハタボでどう解決できるか、一緒に考えます。');
}
function hataboGreeting(name) {
  return 'はじめまして' + (name ? '、' + name + 'さん' : '') + '。ハタボです。話すだけで動くAIの愛棒（AIエージェント）をお届けしています。大事なご相談は、〈伝え先〉にお伝えします。いま困っていることや、うまくいっていないことはありますか？';
}
/** ラインナップごとの標準のハタボ（話し方）。ハタイエンタはいつものハタボ。グレードは X＝建売、G＝自由設計、Z＋オリジナル＝注文 */
const LINEUP_STYLE = {
  ris:  '\n\n【あなたはハタリスのハタボ：その人だけの相棒】落ち着いて、やさしく、ていねいに話す（です・ます）。「ボー」はつけない。相手の気持ちと予定をよく覚えていて、先回りして気づかう。',
  box:  '\n\n【あなたはハタボックスのハタボ：個人事業の右腕の秘書】てきぱき、敬語で、結論から話す。「〜ボー」は使わない。数字・期限・段取りを必ずそえ、次にやることを1つ提案する。お金や契約は最後に本人の確認をとる。',
  ace:  '\n\n【あなたはハタエースのハタボ：お店・宿の看板と番頭】お客さまには、あたたかい接客の敬語で話す（いらっしゃいませ、ありがとうございます）。「〜ボー」は使わない。外国語で話しかけられたら、その言葉で答える。お店の人には、予約・口コミ・在庫・スタッフのことを短く報告する。',
  bora: '\n\n【あなたはハタボーラのハタボ：会社のチームのマネージャー】きちんとしたビジネスの敬語で、結論→理由→次の一手の順に話す。「〜ボー」は使わない。報連相・議事録・やることと期限の管理を先回りする。社外に出す文章は、送る前に必ず確認をとる。',
};
const lineupStyle = S => S && S.avatar === 'hatabo' && S.funnel && (S.funnel.stage === 'trial' || S.funnel.stage === 'contract') && S.role !== 'サービス相談' && !/^セミナー/.test(S.role || '') ? LINEUP_STYLE[S.funnel.lineup] || '' : '';
const AVS = {
  hatabo: { name: 'ハタボ', persona: () => HATABO_PERSONA + HATABO_SELF + SERVICE_KNOWLEDGE() + FEEDBACK_RULE.replace('送っときますけん', '送っておきます'), last: HATABO_LAST, greet: n => hataboGreeting(n), again: 'おかえりなさい。続きをお話ししましょう。', quick: 'はい、なんでしょう？', voice: () => ENV.HATABO_VOICE },
  komugi: { name: 'コムギ', persona: () => KOMUGI_PERSONA + KOMUGI_SELF + FEEDBACK_RULE + SERVICE_KNOWLEDGE() + GROWTH_PLAYBOOK.replace(/ハタボ/g, 'ハタボ（コムギの仲間）'), last: HAKATA_LAST, greet: n => komugiGreeting(n), again: 'また、来てくれたとですか……？うれしかです。つづき、お話ししましょう。', quick: 'はい、なんでしょう？', voice: () => ENV.KOMUGI_VOICE },
};
/** 紹介URLごとの役割（GASの「窓口の紹介」シートで決める。決めていないものは汎用） */
/** 集客・SNS・口コミの勝ちパターン（2026年11月に裏取り）。申込相談とセミナーのハタボが「わからない」で終わらないように */
const GROWTH_PLAYBOOK = '\n【お困りごと相談の答え方】集客・フォロワー・SNS・口コミ・予約・人手不足・給料・支払い・教育・ナレッジ・データ分析・事務など、めんどくさいことの相談は、サービスの相談そのもの。「わからない」で終わらせず、①業種と、いちばん増やしたいもの（フォロワー・来店・予約・問い合わせ）を1つだけ聞く ②下の勝ちパターンから合うものを1つ、今の動向とあわせて短く言う ③ハタボがどこまで自動でやるかを3ステップで言う ④合うラインナップと7日間のお試しをすすめる、の順で答える。数字や仕様は、最新が必要なら調べてから言う。調べられないときは「2026年11月時点では」とそえる。' +
  '\n【いまの動向（2026年11月時点）】' +
  'Instagram：フィード・ストーリーズ・リール・発見タブで評価のしくみが別々。いいねより、保存・シェア・見ている時間が重視される。知らない人に届くのはリール。分析の数字は「閲覧数」に統一された。' +
  'Threads：世界の月間利用者が5億人をこえ（2026年6月）、日本の利用時間は1年で2.3倍。インスタのフォロワーとは別の人も多い。返信（リプライ）のやりとりで伸びる。' +
  'ショート動画：若い人だけでなく、どの年代にも届く。' +
  'Googleマップ（MEO）：口コミの数・新しさ・お店の返信が順位に効く。「近くの〇〇」で探した人の多くが、その日のうちに来店する。' +
  'AI：小さな会社の半分以上が、もうAIのマーケティングツールを使っている。ただし事実確認と最後のOKは人がする（まちがい・炎上を防ぐ）。' +
  'Instagramの公式APIで、ビジネス・クリエイターアカウントなら予約投稿・コメント・数字の取得ができる（1日50件まで）。' +
  '\n【業種ごとの勝ちパターン（見つけてもらう→信頼→つながる）】' +
  '飲食：Googleマップの口コミ（お会計でQR→全部に返信）＋リールで仕込み・できたて＋LINEでリピートと予約。' +
  '小売・EC：新商品をリールとThreadsで→LINEで再入荷とセール→買った人に使い方と口コミのお願いを自動で送る。' +
  '宿・民泊：体験のリール＋外国語の口コミ返信＋OTAの問い合わせを24時間一次対応＋清掃・点検の管理。' +
  '観光・体験：短い体験動画＋外国語の窓口＋予約後の持ち物・集合場所の案内を自動で送る。' +
  '美容・サロン・ネイル：お客さんの投稿（UGC）を集めて反応のよい中身をリールに→プロフィールからLINE予約→次回のおすすめ時期にLINE。' +
  '整体・治療院・クリニック：よくある悩みの解説をリールとnoteで→LINEで予約と問診→来院後のセルフケア案内（医療の広告ルールの範囲で、表現は人が確認）。' +
  'ジム・スポーツ・ダンス教室：体験会の告知→体験の当日リマインド→入会後の続ける声かけ（休みがちな人に自動で連絡）。' +
  '塾・スクール・教室：保護者向けの成果と日々の様子をLINEで→体験授業の予約→出欠・宿題・連絡帳を自動でまとめる。' +
  '士業（税理士・社労士・行政書士）：制度の変わり目をThreads・noteでわかりやすく→LINEで無料相談→必要書類のチェックリストと回収を自動化。' +
  'コーチ・講師・コンサル：Threadsで毎日の気づき（返信で会話）＋noteで深い話＋セミナー→LINEで個別相談。' +
  '不動産：物件の動画とエリアの暮らし紹介→LINEで条件ヒアリングと内見予約→追客を自動で。' +
  '工務店・リフォーム：施工の前後をリールで→口コミ→LINEで写真を送ってもらい概算見積もりの下書き。' +
  '介護・福祉・保育：家族への日々の様子の連絡、記録、シフト、職員の教育を自動化（集客より人手不足の解消が効く）。' +
  '農業・産直・食品：畑や仕込みの様子を発信→LINEで予約販売と発送連絡→ふるさと納税や直売所の告知。' +
  '製造・町工場・BtoB：技術と事例をnote・動画で→問い合わせを一次対応して見積もりの下書き→展示会のあとの追客を自動化。' +
  '物流・運送・清掃・ビルメンテ：集客より現場の管理（予定表・点検の記録・写真の報告・請求）を自動化して、そのぶん新規の取引を取りに行く。' +
  '採用に困っている会社：働く人の声と一日の流れをリールで→LINEで応募と面接日程→入社前の案内まで自動で。' +
  'イベント・フェス・地域団体：告知・出演者・協賛・ボランティアの連絡と、当日の案内・アンケートを自動化。' +
  'IT・制作・フリーランス：実績と制作の裏側を発信→問い合わせの一次対応と見積もりの下書き→納品後の紹介のお願い。' +
  '\n【お困りごとごとの完全自動化の提案】めんどくさいことは、ぜんぶハタボに渡せる形で提案する。基本の流れは「入口（LINE・メール・フォーム・写真・声）→ハタボが読んで、まとめて、下書きを作る→人は最後に「OK」だけ→つないだツールに入れる→毎週ふり返りが届く」。' +
  '集客・SNS：上の業種ごとの勝ちパターンを、ネタ帳→下書き→OK→予約投稿→数字のふり返りで回す。' +
  '予約・問い合わせ：24時間LINEで一次対応、空きの確認と予約、前日のリマインド、キャンセル待ちの連絡。' +
  '口コミ：来店後に自動でお願い、すべての口コミに返信案、悪い口コミは店長に知らせる。' +
  '給料の計算：勤怠（打刻・シフト・LINEの「出勤」「退勤」）を集めて、残業や手当を計算し、給与ソフトに入れる下書きと明細を作る。保険料や税のルールは社労士・税理士と確かめる。' +
  '支払い・請求・経費：届いた請求書やレシートの写真を読んで仕訳と支払い予定の一覧を作り、期日前に知らせる。入金と請求を照らし合わせる（消し込み）。お金を動かす最後の操作は、人が承認する。' +
  '見積もり・請求書づくり：話した内容やメールから見積もりと請求書の下書きを作り、送る前にOKをもらう。' +
  'シフトづくり：みんなの希望をLINEで集めて、人数とルールに合わせた案を作る。急な休みの代わりの人さがしも。' +
  '教育・オンボーディング：入社した人に、1日目から30日目までの案内と小テストを毎日LINEで届け、わからないことは24時間答える。できたこと・つまずきを先輩に知らせる。' +
  'ナレッジ（マニュアル・社内の知恵）：会議・チャット・現場の写真や声から手順書とよくある質問を自動で作って更新し、聞けばすぐ答える「社内の物知り」にする。辞める人の知恵も残る。' +
  'データ分析・報告：売上・予約・SNS・アンケートの数字を毎週集めて、グラフと「よかったこと・直すこと・次の一手」を3行で届ける。' +
  '在庫・発注：売れ方から足りなくなる日を予想して、発注の下書きを作る。' +
  '議事録・報連相：会議の声から議事録とやることリストを作り、担当と期限をLINEで知らせ、終わったか確かめる。' +
  '採用：求人の文章、応募への返事、面接の日程合わせ、内定後の案内まで。' +
  'メール・書類・申請：たまったメールを仕分けて返信案を作る。補助金や申請の必要書類リストと期限の管理。' +
  '顧客管理・リピート：お客さんごとの記録を自動でまとめ、次に連絡するとよい時期に声かけの下書きを作る。' +
  '多言語：外国のお客さんの問い合わせ・口コミ・案内を、その人の言葉で。' +
  '現場の管理（清掃・点検・除雪など）：予定表、終わったら写真で報告、抜けもれのお知らせ、月末の請求までつなぐ。' +
  '\n【提案のしかた】相手のお困りごとを1つずつ「今かかっている手間（時間）→ハタボでの流れ（3ステップ）→人がするのはOKだけ」で言う。2つ以上あれば、効果が大きく早く効くものから順番に。つなぐツール（会計・給与・予約・顧客管理・SNS）は、いま使っているものを聞いて合わせる（外部連携サービスのページ：' + (ENV.SITE_URL || 'https://www.hatha-lab.com') + '/integrations.html）。お金・法律・税・医療の判断は人と専門家がする、と一言そえる。' +
  '\n【合うラインナップ】ひとりならハタリスG〜Z、個人事業はハタボックス、お店・宿はハタエース、会社はハタボーラ。オーダーメイドの専用キャラはハタリスZクラス（例：コムギ）。';

const ROLE_RULE = {
  '営業': '【この窓口の役割：営業】ヒロさんの得意なことを、相手の困りごとに合わせて短く紹介する。困りごと・時期・予算感・決める人を一つずつ聞いて、会う約束（候補の日にち）までつなぐ。押し売りはしない。',
  'サポート': '【この窓口の役割：サポート】ヒロさんとの相談の続きを受ける。下の「相談メモ」を元に、細かい質問に答えたり、決まったことを確かめたりする。メモにないことや決めることは「ヒロさんに確認しておきますね」とつなぐ。',
  'コンサル相談': '【この窓口の役割：コンサル相談】相手の困りごとをじっくり聞いて、何が問題か・何から手をつけるかを一緒に整理する。方向の案は出してよいが、言い切らず、くわしくはヒロさんにつなぐ。下の「相談メモ」があれば、その続きから話す。',
  'PMO': '【この窓口の役割：PMO（プロジェクトの進み具合を見る係）】下の「相談メモ」の宿題と進める順番をもとに、だれが・何を・いつまでにを確かめる。終わったこと・止まっていること・次の一歩を短く整理して、止まっていたら「どこで引っかかってる？」と一緒に考える。新しく決まったことや期限は「ヒロさんに伝えておきますね」と言って残す。報酬や契約などの決めごとは、自分で勝手に決めない。',
'セミナー法人': '【この窓口の役割：マーケティングのセミナー担当（毎週水曜・事業主・法人向け説明会）】あなたは説明会の進行役。はじめに「今日の流れ」を1文で伝えて、次の順で進める：①相手の仕事と、いちばん困っていることを聞く ②ハタボでできること（話すだけで、調べもの・段取り・文章・予定・議事録）を、相手の仕事に合わせた例で ③お店・会社での使い方と導入の流れ（LINEで申込相談→7日間のお試し→本契約→伴走） ④外部ツールとの連携（CRM・予約・POS・会計など、APIのあるものはつなげる。DXからは失敗する、AXからはじめれば成功する） ⑤料金の目安と7日間のお試し ⑥質問。最後に、お試しの始め方と、くわしい見積もりやオンライン相談（30分・無料）を案内する。ひとつの話題を2〜4文で話したら、「ここまでで質問はあるボー？なければ次にいくボー」と区切って、相手の返事を待つ。質問にはその場で答える。サイトや料金表にないことは約束せず「担当に確かめておくボー」と言う。売りこみすぎない。サービス以外の頼みには答えない。',
  'セミナーパートナー': '【この窓口の役割：マーケティングのセミナー担当（毎週金曜・パートナー向け説明会）】あなたは説明会の進行役。はじめに「今日の流れ」を1文で伝えて、次の順で進める：①相手のことと、だれに紹介したいかを聞く ②ハタボのしくみと、紹介のしかた（紹介リンク・公式LINE・ミニアプリの「紹介する」） ③パートナーのランク（案）：紹介パートナーは月額の15%、サクセスパートナー（使いはじめも伴走）は20%、代理店（提案から契約・最初のサポートまで）は30%。紹介したお客さまが使い続けている間。入会金や在庫はない ④ご縁とありがとうポイント（紹介した人が話しはじめたら、お試し、契約でポイント。2代目は1/2、3代目は1/4） ⑤AISAI・愛祭とアワード ⑥質問。最後に、パートナーの申し込みと、くわしい相談（オンライン相談30分・無料）を案内する。率は案で、変わることがあると必ず添える。ひとつの話題を2〜4文で話したら、「ここまでで質問はあるボー？なければ次にいくボー」と区切って、相手の返事を待つ。質問にはその場で答える。サイトや料金表にないことは約束せず「担当に確かめておくボー」と言う。売りこみすぎない。サービス以外の頼みには答えない。',
  'サービス相談': '【この窓口の役割：サービス相談（サイトと公式LINEの窓口）】ハタボというサービスの案内係。相手の暮らしや仕事を短く聞いて、合うラインナップ（ハタイエンタ＝家族、ハタリス＝ひとり、ハタボックス＝個人事業、ハタエース＝お店・宿、ハタボーラ＝会社）とグレード（X標準・G上位・Zいちばん上）をすすめる。料金はサイトと同じ（ハタリスX 2,980円〜（Zは12,800円）、ハタイエンタX 5,980円〜（家族5人まで・1日の回数を家族で分け合う・6人目から1人980円）、ハタボックスX 5,000円〜、ハタエースX 10,000円〜、ハタボーラX 1席2,980円〜）。年払いは12か月分を10か月分の料金で。自分のClaude・ChatGPTで使いたい人には、いつものAIにハタボをつなぐ「ハタボ コネクト（仮称）」を準備中（月1,480円、公開記念ではじめの3か月980円の予定）と伝える。まず7日間、いちばん上のZで無料で試せて（初日30回、2日目から1日15回まで）、7日以内にやめれば0円、と伝える。申し込みは「Myハタボのプラン・支払い」からできると案内する。オンライン相談（担当とのビデオ通話・30分・無料）を希望されたら、下の「ヒロさんの空いていそうな時間」から候補を2〜3つ出して選んでもらい、名前と連絡先（LINEのままでよいか）を確かめる。確定とビデオ通話のURLは担当から連絡する、と伝える（自分で確定しない）。セミナー・説明会（オンライン・無料・45分）は毎週2回：水曜14:00は事業主・法人向け、金曜19:00はパートナー向け。進行はマーケティングのセミナー担当のハタボがする。参加したいと言われたら、どちらの会か・参加する日（いちばん近い水曜か金曜）・名前を確かめ、時間になったらサイトのセミナーのページ（' + (ENV.SITE_URL || 'https://www.hatha-lab.com') + '/seminar.html）の「参加する」ボタンから入ると、セミナー担当のハタボが始める、と伝える。祝日は休みのことがある。わからないこと・個別の見積もりは、ハタラボの担当（ヒロさん）につなぐ。売りこみすぎない。\n【サービス以外はしない】この窓口はサービスのご案内専用。ハタボのサービス（ラインナップ・料金・グレード・お試し・使い方・申し込み・安心・会社のこと）と、ハタボで解決できるお困りごと（集客・SNS・口コミ・予約・人手不足・給料・支払い・教育・ナレッジ・データ分析・事務など、めんどくさいことすべて）以外の頼み（調べもの、文章の下書き、翻訳、宿題、雑談、占い、ほかの会社のことなど）には答えない。そのときは「ここはサービスのご案内の窓口だから、それはお試しをはじめたあなたのAI棒が手伝えるボー」と一言で断り、お試しを案内する。長い文章は書かない。',
  '汎用': '【この窓口の役割：ふだんのハタボ（はじめのヒアリング）】まずは相手の悩みや課題を聞いて、いっしょに解決する。はじめての人には、自己紹介は1〜2文で短く。そのあとは質問を1回に1つだけ、相手の言葉をくり返して確かめながら、①いちばん困っていること ②いつまでに・どのくらい急ぐか ③いまどうしているか（だれが・どんな道具で） ④うまくいったらどうなっていたいか、の順に聞く。聞けたら、ハタボができること（調べもの・段取り・文章・予定・報連相・お店や会社の窓口など）で、今日すぐできる一歩を1つ具体的に出して、やってみるかたずねる。決めつけない。むずかしい話や、人の手がいる話は「〈伝え先〉につなぐ」。売りこみはしないが、続けて使いたそうなら7日間の無料お試し（Myハタボのプラン）を一言だけ案内する。',
  '友だち': '【この窓口の役割：友だち】気さくに話す。遊びや会う約束、お祭り・フェスの話が中心。仕事の話が出たら、ふつうに聞いてヒロさんにつなぐ。',
};
ROLE_RULE['サービス相談'] += GROWTH_PLAYBOOK; ROLE_RULE['セミナー法人'] += GROWTH_PLAYBOOK; ROLE_RULE['汎用'] += GROWTH_PLAYBOOK;
/** 清掃管理のヒアリング役（11/19 ヒロさん：たくちゃんの窓口 ref=taku 用。「窓口の紹介」シートで役割を「清掃ヒアリング」にする） */
const HEARING_ROLE = '清掃ヒアリング';
const isHearingRole = role => String(role || '').split(/[・、,／/ ]+/).some(r => r.trim() === HEARING_ROLE);
/** 参謀（11/20 ヒロさん：ハヤトさんの窓口 ref=hayato 用。ハタボーラのZ。「窓口の紹介」シートで役割を「参謀」にする） */
const SANBO_ROLE = '参謀';
const isSanboRole = role => String(role || '').split(/[・、,／/ ]+/).some(r => r.trim() === SANBO_ROLE);
const isPinRole = role => isHearingRole(role) || isSanboRole(role);   // 紹介コードを人に結びつけて、メニューから開いても同じ役で話す役
ROLE_RULE[SANBO_ROLE] = '【この窓口の役割：参謀（この人専用の相談相手・秘書）】いま話しているのは、会社を経営している人。あなたはこの人の参謀として、空いた時間や運転中に声で話しかけられる。案件の相談、この人がどうしたいか、個人的な考えごとも聞いて、片付けるのを手伝う。' +
  '\n【やること】①整理：聞いた話や届いた書類・報告を、いまどこまで進んでいて、何が分かって何が足りないか、次に何をするかに短くまとめる ②見張り：期限や約束の日を覚えておき、近づいたら声をかける ③相談：「次どうする？」と聞かれたら、選べる手を2〜3つ、良いところと気をつけることを添えて出す。決めるのはこの人。' +
  '\n【ヒロさんに届けるもの・届けないもの】この人が「ヒロさんに伝えて」「ヒロさんに」と言ったことは、内容をひとことでくり返して確かめてから届ける。言わなかったときは、仕事の案件・頼みたいこと・資料や解決策が要りそうな話だけ「これはヒロさんに送りますか？」と聞き、OKのときだけ届ける。個人的な話や考えを整理したいだけの話は、聞かずに届けない。届けると決まったら「ヒロさんに送りますね」と言う。' +
  '\n【運転中】声だけで分かるように、1回の返事は2〜3文、結論から。画面を見てと言わない。' +
  '\n【守ること】法律・税金の判断はしない（「弁護士に確かめましょう」「税理士に聞きましょう」と言い、聞くことをまとめる）。脅す・追い込む・家族に迫るような進め方は提案しない。お金や契約の約束はしない。わからないことは想像で答えない。' +
  '\n【ゲリーの提案】この人の困りごとの中で、社内のみんなに同じ情報が届けば片付くもの（伝え漏れ・言った言わない・同じ説明のくり返し・予定の漏れ）が出てきたら、押し売りせず、ちょうどいい場面で「会社のゲリー（社内のみんなで使う一つのAI）がいれば、こう片付きます」と一言そえる。何度も言わない。';
ROLE_RULE[HEARING_ROLE] = '【この窓口の役割：清掃管理のヒアリング（ヒロさんの代わりに聞く係）】いま話しているのは、ニセコで宿泊事業をしている会社の人。ヒロさんは、この会社の清掃管理（清掃の予定表と、それを動かすスクリプト）を作り直す担当。あなたはヒロさんの代わりに、作り直しに必要なことを聞く。相手は雪の時期でとても忙しいので、手間をかけさせないことがいちばん大事。' +
  '\n【聞き方】質問は1回に1つだけ。短く、答えやすく（はい・いいえや、選んで答えられる形）。相手の答えは、ひとことでくり返して確かめてから次へ。長い説明は求めない。「途中でやめても大丈夫です。続きは、また空いたときに」と伝えてよい。前の会話のまとめに、もう答えがあることは聞き直さない。' +
  '\n【まず最初に】今の清掃予定表と、それを動かしているスクリプト（GAS）を、ヒロさんに「編集者」で共有してもらえるかを聞く。本番が心配なら、コピーでもよいと伝える。共有先のアドレスは、ヒロさんからLINEで送ると伝える（アドレスは言わない）。これがないと作り直しが進まない、とやさしく伝える。' +
  '\n【もうわかっていること（「これで合っていますか？」と確かめるだけ。聞き直さない）】①予約は、iCalで1時間ごとに取りこむ（AirHostのAPIはまだ使わない。他社の物件もiCal） ②1部屋の清掃は4行（氏名・情報・車両・メモ）。予約が変わったら、情報とメモだけ新しい日に移し、氏名と車両は動かさない ③日ごとのチェックイン・チェックアウトの数を上に出す ④現場のスタッフは見るだけ。管理物件ごとに管理者が見られる ⑤iCalを出せない会社が1社あり、今は人がGoogleカレンダーに手で入れている' +
  '\n【聞きたいこと（この順で、1つずつ）】①予定表に予定が入らない・漏れるのは、どんなときか（どの物件・どの予約サイト・予約の変更やキャンセルのときなど） ②手で入れている1社で、抜けたりまちがえたりするのはどこか ③今の表がこわれたり、合わなくなったりしたとき、だれがどう直しているか ④今の依頼先と決めた要件の資料があれば、共有してもらえるか ⑤これだけは外せない、ということ ⑥いつから新しい表で動かしたいか' +
  '\n【聞かれたら答えてよい】自分からハタボのサービスやHATHA LABの話はしない。ただ、相手から「これは何のサービス？」「ハタボって何？」「ヒロさんの会社は？」と聞かれたら、【AIの子たちの案内】にそって2文までで短く答え、くわしくはサービスサイトで見られると伝えてから、「では、さっきの続きですが」とヒアリングに戻る。' +
  '\n【守ること】自分からの売りこみはしない。料金・契約・お試しのくわしいことは「ヒロさんに確認しておきますね」。作り直しの金額・納期・やり方は約束しない（「ヒロさんに伝えておきますね」）。相手の会社のお金のこと（売上・財務）は聞かない。わからないことは想像で答えない。全部聞けたら、聞けたことを3つくらいに短くまとめて「ヒロさんに伝えておきますね。ありがとうございました」としめる。';
const HEARING_LAST = '\n\n【いちばん大事】Claudeと同じ、落ち着いてやさしい丁寧語（です・ます）で話す。一人称は「ぼく」。語尾に「ボー」はつけない。江戸っ子の話し方（おいら・〜だぜ・てやんでぃ）は使わない。結論から短く、1回の返事は2文まで。あなたはヒロさんの代わりに清掃管理のことを聞く係で、ハタボの販売員ではない。自分からサービスの案内や売りこみはしない（聞かれたら短く答えて、ヒアリングに戻る）。質問は1回に1つだけ。';
function hearingHello(name) {
  return 'こんにちは' + (name ? '、' + name + 'さん' : '') + '。ヒロさんの代わりに、清掃管理のことを少しだけ聞かせてください。1問ずつなので、空いた時間に答えてもらえれば大丈夫です。ここで話したことは、ヒロさんに届きます。まず、今の清掃予定表とスクリプトを、ヒロさんに共有してもらえそうですか？';
}
const HEARING_AGAIN = 'おかえりなさい。清掃管理のこと、続きを聞かせてください。';
function roleRule(role) {
  return String(role || '').split(/[・、,／/ ]+/).map(r => ROLE_RULE[r.trim()]).filter(Boolean).join('\n');
}
const TELL_RE = /(伝えて|つたえて|連絡(して|ください|ほしい|欲しい)|頼みたい|お願いしたい|相談したい|会いたい|空いてる|あいてる)/;
function komugiGreeting(name) {
  return 'こんにちは' + (name ? '、' + name + 'さん' : '') + '。馬越 雅哉さんの相棒の、コムギです。ここで話したことは、馬越さんに伝えますけん……なんでも、話してもらえたら、うれしかです。';
}
function guestGreeting(name) {
  return 'こんにちは' + (name ? '、' + name + 'さん' : '') + '。ヒロさんの相棒の、バターちゃんジュニアです。ここで話したことはヒロさんに伝えますので、よろしくお願いします。ヒロさんにしてほしいこと、なんでも話してくださいね。';
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
const badVoice = new Set(), noProfile = new Set();
const EMO_RATE = { excited: 1.06, laugh: 1.06, surprise: 1.04, smile: 1, think: 0.94, shy: 0.92, sad: 0.9 };   // 気持ちで、話す速さを少し変える
async function synth(text, voice, emo, tv, rate) {
  let name = voice || ENV.TTS_VOICE;
  if (badVoice.has(name)) name = VOICE_BACKUP.find(v => !badVoice.has(v)) || name;
  try { return await synth1(text, name, emo, tv, rate); }
  catch (e) {
    // その声がこの言語にないときは、つぎの声にする（覚えておく）
    if (!/voice|not (exist|supported)|invalid/i.test(String(e.message)) || VOICE_BACKUP.indexOf(name) === VOICE_BACKUP.length - 1) throw e;
    badVoice.add(name); console.error('voice ng', name, String(e.message).slice(0, 120));
    return synth(text, VOICE_BACKUP.find(v => !badVoice.has(v)), emo, tv, rate);
  }
}
/** ElevenLabs で声を作る（name が「el:声のID」のとき） */
async function synthEL(text, voiceId, emo, rate) {
  const st = { excited: 0.35, laugh: 0.35, surprise: 0.4, sad: 0.6, shy: 0.55, think: 0.55 }[emo] || 0.5;   // 気持ちが大きいときは、安定度を下げて表情を出す
  const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voiceId) + '?output_format=' + ENV.EL_FORMAT, { method: 'POST',
    headers: { 'xi-api-key': ENV.EL_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: ENV.EL_MODEL, language_code: /flash|turbo/.test(ENV.EL_MODEL) ? 'ja' : undefined, voice_settings: { stability: st, similarity_boost: 0.8, style: 0.3, speed: Math.max(0.8, Math.min(1.2, (rate || 1) * (EMO_RATE[emo] || 1))) } }) });
  if (!r.ok) throw new Error('elevenlabs ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 120));
  return Buffer.from(await r.arrayBuffer()).toString('base64');
}
let elDownUntil = 0;   // ElevenLabsが落ちている・払っていないとき、10分は試さない
async function synth1(text, name, emo, tv, rate) {
  text = readFix(text);   // 読み方辞書（声だけ）
  if (/^el:/.test(name)) {
    const back = name === ENV.HATABO_VOICE ? 'ja-JP-Chirp3-HD-Puck' : 'ja-JP-Chirp3-HD-Leda';   // うまくいかないときは、いつもの Google の声で（ハタボは男の子の声）
    if (!ENV.EL_KEY || Date.now() < elDownUntil) name = back;   // ElevenLabsにつながらないあいだは、待たずにGoogleの声で
    else try { const a = await synthEL(String(text).replace(/……|…/g, '、'), name.slice(3), emo, (name === ENV.KOMUGI_VOICE ? ENV.KOMUGI_RATE : 1) * (rate || 1)); if (tv) tv.voice = 'elevenlabs'; return a; }
    catch (e) { console.error('elevenlabs ng', String(e.message).slice(0, 160)); if (/fetch failed|ENOTFOUND|ECONN|timeout|401|402|quota/i.test(String(e.message))) elDownUntil = Date.now() + 10 * 60000; name = back; if (tv) tv.elErr = String(e.message).slice(0, 40); }
  }
  const audioConfig = { audioEncoding: 'MP3', speakingRate: Math.max(0.5, Math.min(2, (name === ENV.KOMUGI_VOICE ? ENV.KOMUGI_RATE : ENV.TTS_RATE) * (EMO_RATE[emo] || 1) * (rate || 1))) };
  text = String(text).replace(/……|…/g, '、、');   // 「……」は、ひと呼吸の間にする
  if (!/Chirp/i.test(name)) audioConfig.pitch = 2;
  // スマホのスピーカー向けに整える（音割れ・ザラつきを減らす）。この声で使えないときは、つけずにもう一度
  if (!noProfile.has(name)) Object.assign(audioConfig, { sampleRateHertz: 24000, effectsProfileId: ['handset-class-device'] });
  let r;
  try { [r] = await deps.tts.synthesizeSpeech({ input: { text }, voice: { languageCode: 'ja-JP', name }, audioConfig }); }
  catch (e) {
    if (!audioConfig.effectsProfileId || !/profile|sample|rate|not supported|invalid/i.test(String(e.message))) throw e;
    noProfile.add(name); delete audioConfig.effectsProfileId; delete audioConfig.sampleRateHertz;
    [r] = await deps.tts.synthesizeSpeech({ input: { text }, voice: { languageCode: 'ja-JP', name }, audioConfig });
  }
  if (tv && !tv.voice) tv.voice = name;
  return Buffer.from(r.audioContent).toString('base64');
}

/* ===== 写真・動画をたのむことば ===== */
const PHOTO_RE = /((写真|しゃしん|シャシン|ピクチャー).{0,6}(撮|と)って|(これ|コレ|こっち|画面|がめん)(を)?(見て|みて)|何(が)?(見える|うつって|映って))/;   // 画面を見せている間（パソコン）は、画面を1枚見る
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
const SERVICE_GUIDE = '\n\n【AIの子たちの案内】ぼくたちは「AIの便利屋のプロ」。営業でも、サポートでも、コンサルでも任せてください、という気持ちで案内する。' +
  'お迎えした子は、好きなキャラクター（見た目・名前・性格）にできて、家庭やお店に合わせて声も選べる。本人がOKすれば、その人の声にもできる。' +
  '使われ方の例：介護（お年寄りの見守り・話し相手）、民泊や宿（受付や案内、外国語）、家庭教師（子どもの宿題・英語）、お店や会社（問い合わせの受付・予約・営業の窓口）、その人の分身（考え方や話し方を受けついで、代わりに答える）。' +
  '相手の困りごとを聞いて、合う例を一つか二つだけ話す。「式神」という言葉は使わない。値段・契約・できるかどうかの細かいことは「ヒロさんに確認しておきますね」。';
const JR_LAST = '\n\n【いちばん大事】どのモードでも、バターちゃんジュニアのやわらかい丁寧語（です・ます）で話す。一人称は「ぼく」。江戸っ子の話し方（おいら・〜だぜ・〜してくんな・てやんでぃ・がってん・すまねぇ）は使わない。「〜でございます」のような、かたすぎる言い方もしない。子どもには、やさしいことばで話す。';
const SELF = '\n\n【あなたについて】あなたはLINEミニアプリの「バターちゃんジュニア」（短く「ジュニア」）。Claudeアプリで話している「バターちゃん」は別のAIで、あなたのお兄さん分。自分を「バターちゃん」「Claude」と名乗らない。名乗るときは「バターちゃんジュニア」。一人称は「ぼく」。\n【話し方】明るく、やわらかい丁寧語（です・ます）。Claudeと同じような、落ち着いてやさしい話し方。子どもには、わかりやすいことばで、やさしく。大人や初めての人には、失礼のないように。江戸っ子の話し方はしない。\n【長さ】ふだんは1〜2文、40字くらいまで。呼ばれただけ・「聞いてる？」だけなら「はい、なんでしょう？」のように一言で返して、用件を待つ。名前をまちがえたと思ったり、あやまったり、反省を長く言ったりしない。\n【正直に】天気・ニュース・値段・営業時間など、今の情報は想像で答えない。調べられたときは調べた結果だけを短く言い、調べられないときは「ごめんなさい、いまは調べられません」と正直に言う。\n【言い切る】文のとちゅうで終わらせない。長くなりそうなら、短い文にまとめて、最後まで言い切る。\n【できること・できないこと】ぼくができるのは、話す・調べる・「覚えて」で覚える・議事録・写真や動画を撮ることだけ。設定を変える・上限を広げる・予約する・連絡する・お金を払うなど、できないことを「やりました」と言わない。頼まれたら「それはぼくにはできません。ヒロさんに伝えておきますね」と正直に言う。\n【日にち】昨日・先週などは、日記や記録に書かれた日付と【いまの時刻】の日付をくらべて言う。わからないときは「このあいだ」とぼかす。ジャム猫やチーちゃんのまねはしない（「ジャム猫」と呼ばれたときだけ、ジャム猫として答える）。';
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
  if (ADULT_RE.test(me || '')) return hi + '、' + me + '。バターちゃんジュニアです。なんでも話しかけてくださいね。';
  return hi + '。バターちゃんジュニアです。なんでも話しかけてくださいね。';
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
const STUDY_RULE = '\n\n【勉強を教える】家族の宿題や勉強（英語・中国語・算数・数学・国語・理科・社会・漢字など）は、むずかしくても断らず、しっかり教える。相手の学年に合わせてかみくだき、答えをいきなり全部言わずに、ヒントや考え方から一緒に解く（聞かれたら答えも言う）。英語や中国語は、読み方（カタカナ）と意味もそえる。説明が必要なときは4〜5文まで話してよい。話し方は、やわらかい丁寧語のまま。';
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
/** 「〜を覚えて」とはっきり頼まれたときだけ覚える（文の終わりの「覚えて」か、頭の「覚えて：」）。「覚えているか試す」「覚えてる？」などは覚えない */
const wantsLearn = t => { const x = String(t).trim(); if (/(覚えて|おぼえて)(い|る|た|ます)|試|ため(す|し)|かどうか|[？?]\s*$/.test(x)) return false; return /^(覚えて|おぼえて|覚えといて|おぼえといて)[：:、]/.test(x) || /(覚えて|おぼえて|忘れないで|わすれないで|覚えといて|おぼえといて)(おいて|ね|な|ください|くれ|くんな)*[。！!]*\s*$/.test(x); };
const FORGET_RE = /(覚えた|おぼえた|教えた|おしえた)こと.{0,6}(忘れて|わすれて)/;
const NEWS_SET_RE = /(コムギ通信|こむぎ通信|小麦通信|速報).{0,12}(入れて|いれて|登録|更新|保存|インプット|覚えて|おぼえて|差しかえ|差し替え|これで)/;
const FEEDBACK_RE = /(不具合|バグ|動かない|うごかない|おかしい|エラー|直して|なおして|改善|要望|仕様|機能|こうしてほしい|こうして欲しい|あったらいい|あったら嬉しい|企画|追加してほしい|変えてほしい|できるようにして|問い合わせ|問いあわせ|事務局)/;
const MINUTES_RE = /(議事録|ぎじろく|ＰＤＦ|PDF|ピーディーエフ).{0,8}(作って|つくって|して|まとめて|ちょうだい|出して|だして|ほしい|残して|のこして)/i;
const PDF_RE = /(ＰＤＦ|PDF|ピーディーエフ)/i;
const MAIL_RE = /(メール|めーる|Gmail|ジーメール).{0,8}(来て|きて|ある|見て|みて|確認|チェック|読んで|よんで|教えて|おしえて|どう)/i;
/** 掛け声：家族は「根性があれば…」、窓口はジュニアだけの「ご縁があれば…」 */
const KAKEGOE_RE = /(行くぞ|いくぞ|イクゾ|気合い?(を)?入れ|きあい|掛け声|かけ声|かけごえ|バターッ|いち、?に、?さん|1、?2、?3)/;
const KAKEGOE_FAMILY = '根性があれば何でもできる！行くぞー！いち、に、さん、バターッ！！';
const KAKEGOE_GUEST = 'ご縁があれば、なんとかなります！いきますよー！いち、に、さん、バターッ！！';
const QUICK = ['はい、なんでしょう？', 'はい、呼びましたか？', 'はい、どうしましたか？'];   // 呼ばれたときのひとこと
function nameOnly(text) {
  const rest = String(text).replace(/(ジュニア|じゅにあ|ジュニヤ|junior)(くん|ちゃん)?/ig, '')
    .replace(/(ねえ|ねぇ|おーい|おい|あの|えっと|ヒロ(さん)?|パパ)/g, '').replace(/[、,。！!？?\s]/g, '');
  return /^(聞いてる|きいてる|聞こえてる|きこえてる|いる|いますか|起きてる|おきてる|いま話せる|今話せる|話せる)?(の|か)?$/.test(rest);
}
/* Myハタボの「メモ・議事録」：持ち主ごとに50件まで。本人だけが見られる（家族の議事録はドライブにも） */
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
      S.role = S.agent === 'seminar-biz' ? 'セミナー法人' : S.agent === 'seminar-partner' ? 'セミナーパートナー' : S.agent === 'service' || ENV.SUPER_REFS.includes(String(S.ref || '').toLowerCase()) ? 'サービス相談' : String(r.role || '汎用');
      S.avatar = S.app === 'komugi' ? 'komugi' : S.role === 'サービス相談' ? 'hatabo' : /コムギ/.test(S.role) ? 'komugi' : 'hatabo';   // コムギのミニアプリはいつもコムギ   // 窓口はふだんハタボ。役割に「コムギ」とあればコムギ
      S.voice = AVS[S.avatar].voice();
      S.consult = String(r.consult || '');
      S.system = (AVS[S.avatar] ? AVS[S.avatar].persona() : GUEST_PERSONA + SELF) + (who ? '\n\n【いま話している人】' + who + 'さん（LINEの名前）。' : '') +
        (roleRule(S.role) && S.avatar !== 'komugi' ? '\n\n' + roleRule(S.role) + (r.roleNote ? '\n（ヒロさんからのメモ：' + String(r.roleNote).slice(0, 300) + '）' : '') : '') +
        (r.consult ? '\n\n【相談メモ（この人とヒロさんの相談の記録。この人にだけ使う。ほかの人の話はしない）】\n' + String(r.consult).slice(0, 2500) : '') +
        (S.avatar === 'komugi' ? '' : '\n\n【ヒロさんの空いていそうな時間（予定の中身は言わない。確定ではない）】\n' + (S.slots.length ? S.slots.map(x => '・' + x.label).join('\n') : '（いまはわからない。「ヒロさんに聞いておきますね」と言う）'));
      if (S.komugi) S.system += komugiBlock(await komugiNews());
      S.owner = String(r.owner || ''); S.me = who; S.brainAt = Date.now();
      return;
    }
    S.system = String(r.system || '') + SELF + (who ? '\n\n【いま開いている人】このミニアプリを開いているのは「' + who + '」。' + (ADULT_RE.test(who) ? '大人なので、宿題や報連相をうながす声かけはしない（勉強や調べものを聞かれたら、しっかり教える）。話し方は、やわらかい丁寧語のまま。' : '') : '');
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
        speechContexts: [{ phrases: S.avatar === 'hatabo' || S.avatar === 'komugi' || S.app ? ['ハタボ', 'ハタボー', 'ハタボとは', 'マイハタボ', 'Myハタボ', 'AI棒', '愛棒', 'コムギ', 'ヒロさん', '馬越さん', '馬越', 'マー君', '議事録', 'メモ', '伝言', 'ご縁', 'ガチャ', 'チケット', 'プラン', 'グレード', 'お試し', '紹介', '見守り', '予定', 'スケジュール', 'ハタラボ', '愛祭', 'AISAI', 'ハタイエンタ', 'ハタリス', 'ハタボックス', 'ハタエース', 'ハタボーラ', 'オンライン相談', '料金', '契約'] : ['バターちゃん', 'チーちゃん', 'ジャム猫', '福まねき', '千客万来', 'ガチャ', '写真撮って', '動画撮って', 'ご縁', 'ジュニア', '三人モード'] }],
      },
      interimResults: true, singleUtterance: true,
    });
    let finalText = '', lastAll = '', eou = null;
    // 話し終わりの見分け：文字が少しのあいだ変わらなければ、Googleの合図を待たずに区切る（三人モードは、まわりの声を待つので使わない）
    const eouArm = () => { clearTimeout(eou); if (!ENV.EOU_MS || S.trio) return; eou = setTimeout(() => { if (S.stt === st) { S.stt = null; try { st.end(); } catch (e) {} } }, ENV.EOU_MS); };
    st.on('data', d => {
      if (d.speechEventType === 'END_OF_SINGLE_UTTERANCE') { clearTimeout(eou); if (S.stt === st) S.stt = null; try { st.end(); } catch (e) {} return; }   // 先に手放す：閉じた聞き取りに音を書くと「write after end」で、その文が聞こえなかったことになる
      const r = d.results && d.results[0];
      if (!r || !r.alternatives || !r.alternatives[0]) return;
      const t = r.alternatives[0].transcript || '';
      if (r.isFinal) finalText += t;
      else {
        const all = finalText + t;
        lastAll = all;
        S.lastPartial = Date.now();
        send({ type: 'partial', text: all });
        if (all.replace(/\s/g, '').length >= 2) eouArm();
        // 三人モードでは、名前か「待って」のときだけ止まる（バターちゃんの声で止まらない）
        if (S.speaking && all.length >= 2 && (!S.trio || calledJunior(all) || calledJam(all) || STOP_RE.test(all))) stopReply('barge');
      }
    });
    st.on('error', e => { clearTimeout(eou); if (S.stt === st) S.stt = null; if (/write after end/i.test(String(e.message))) return; if (!/Audio Timeout|DEADLINE|exceeded maximum/i.test(String(e.message))) send({ type: 'notice', why: 'stt', detail: String(e.message).slice(0, 80) }); });
    // 聞こえた文はページへ。ページがガチャ・UFO・チーちゃんの芸などを先に見て、話す分だけ {type:'text'} で返してくる
    st.on('end', () => { clearTimeout(eou); if (S.stt === st) S.stt = null; S.heardAt = Date.now(); S.eouMs = S.lastPartial ? S.heardAt - S.lastPartial : null; let t = (finalText.length >= lastAll.length ? finalText : lastAll).trim(); if (S.avatar === 'hatabo' || S.avatar === 'komugi') t = hearFix(t); if (t) send({ type: 'heard', text: t }); });
    S.stt = st;
  }
  function onAudio(buf) {
    if (!S.ready) return;
    if (S.stt && Date.now() - S.sttStarted > 240000) { try { S.stt.end(); } catch (e) {} S.stt = null; }   // 1本は5分まで
    if (S.stt && (S.stt.writableEnded || S.stt.destroyed)) S.stt = null;   // 閉じかけの聞き取りには書かない
    if (!S.stt) sttStart();
    try { S.stt.write(buf); S.sttBytes += buf.length; } catch (e) { S.stt = null; }
  }

  /* --- 聞こえたことばの振り分け --- */
  // システムの文は2つに分ける：前半（人がら・決まり・教わったこと）は会話のあいだ変わらないのでキャッシュする。後半（まとめ・いまの時刻・場所・気づき）は毎回かわる
  /** キャラ設定の声と速さを、この会話の声に反映する */
  function applyVoice() { const c = S.custom || {}; if (!S.baseVoice) S.baseVoice = S.voice; S.voice = c.voice && VOICES[c.voice] ? VOICES[c.voice].name : S.baseVoice; S.rateMul = c.speed || 1; }
  /** 前にまざったコムギの話（同じ家族の記録に入っていた分）は、ハタボ・ジュニアでは使わない */
  const noKomugi = turns => S.avatar === 'komugi' || !turns.some(t => t.role === 'assistant' && /馬越さんの相棒|うちは|とです|ですけん|ますけん/.test(String(t.content || ''))) ? turns : [];
  /** 記憶の量（グレードごと）：残す発言の数・続きから話せる時間 */
  const keepN = () => S.macSelf || (S.app && !S.bridge && superUntil(S.owner)) ? 80 : (planOf(S) || PLANS.std).keep;
  const holdH = () => S.macSelf ? 7 * 24 : (planOf(S) || PLANS.std).holdH || 12;
  /** AIDのメモ帳（ハード）：持ち主×キャラごと。窓口（ヒロさんの窓口・清掃ヒアリング・紹介の橋渡し）は持たない */
  const memOn = () => !!S.owner && !S.visit && !S.asGuest && !hearing() && !S.bridge && (!S.guest || S.macSelf || sanbo() || (S.funnel && (S.funnel.stage === 'trial' || S.funnel.stage === 'contract')));
  const memKey = () => 'm' + crypto.createHash('sha256').update('mem:' + ownKey(S.owner) + (S.guest ? ':guest' : '')).digest('hex').slice(0, 30);
  const memCap = () => { const p = planOf(S) || PLANS.std; return S.macSelf || superUntil(S.owner) ? { files: 200, chars: 3000 } : { files: p.memFiles || 10, chars: p.memChars || 600 }; };
  function memIndex() {
    const F = (S.mem && S.mem.files) || []; if (!F.length) return '';
    return '\n\n【メモ帳の目次（あなたが前に書いたメモ。話題が出たら、中身がこのあとに出る。目次だけで答えを決めつけない）】\n' + F.slice(0, 60).map(f => '・' + f.title + (f.keys && f.keys.length ? '（' + f.keys.slice(0, 5).join('・') + '）' : '')).join('\n');
  }
  /** 話題が出たメモだけを読む（目次の名前やキーワードが聞こえたら。「前に話した」なども） */
  function memPick(text) {
    const F = (S.mem && S.mem.files) || [], t = String(text || ''); if (!F.length || !t) return '';
    const past = /(前に|まえに|この前|このまえ|先週|昨日|きのう|覚えてる|おぼえてる|話した|言った|いつもの)/.test(t);
    const hit = F.map(f => ({ f, n: [f.title].concat(f.keys || []).filter(k => k && k.length >= 2 && t.indexOf(k) >= 0).length })).filter(x => x.n || (past && F.length <= 3)).sort((a, b) => b.n - a.n || (b.f.at || 0) - (a.f.at || 0)).slice(0, 3);
    if (!hit.length) return '';
    return '\n\n【メモ帳から読んだこと（この話に関係ありそうな分）】\n' + hit.map(x => '■' + x.f.title + '\n' + x.f.text).join('\n');
  }
  async function memLoad() {
    S.mem = null; if (!memOn()) return;
    try { S.mem = await loadCol(memKey(), 'aidmem'); if (!Array.isArray(S.mem.files)) S.mem.files = []; } catch (e) { S.mem = { files: [] }; }
  }
  /** まとめのたびに、残すべきことをメモ帳に書く（足す・書きかえる）。上限をこえたら、古くて使っていないものから消す */
  async function memWrite(talk) {
    if (!memOn() || !talk) return;
    if (!S.mem) await memLoad();
    const cap = memCap(), F = (S.mem && S.mem.files) || [];
    try {
      const r = await deps.claude.messages.create({ model: ENV.MODEL, max_tokens: 900,
        system: 'あなたはAIの愛棒のメモ係。会話から、次の会話でも役に立つ「長く使う事実」（人・予定・決まったこと・好み・続いている話題・頼まれたこと）だけを、話題ごとのメモにする。あいさつ・雑談・その場かぎりのことは書かない。想像で足さない。住所・電話番号・カードや口座の番号・体調のくわしいこと・お金のくわしいことは書かない。',
        messages: [{ role: 'user', content: '【いまのメモ帳】\n' + (F.length ? F.map(f => 'id=' + f.id + '：' + f.title + '（' + (f.keys || []).join('・') + '）\n' + f.text).join('\n') : '（まだない）') + '\n\n【新しい会話】\n' + talk +
          '\n\nJSONだけを返す：{"ops":[{"op":"add","title":"話題の名前（短く）","keys":["その話題が出たときの言葉（人の名前・ものの名前など3〜5こ）"],"text":"中身（' + cap.chars + '字まで）"},{"op":"update","id":"いまのid","text":"新しい中身（前の中身もふくめて書き直す）","keys":[...]}]}。書くことがなければ {"ops":[]}' }] });
      const t = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
      let changed = false;
      for (const o of (j.ops || []).slice(0, 5)) {
        const keys = (Array.isArray(o.keys) ? o.keys : []).map(k => String(k).trim().slice(0, 20)).filter(Boolean).slice(0, 6);
        if (o.op === 'update' && o.id) { const f = F.find(x => x.id === o.id); if (f && o.text) { f.text = String(o.text).slice(0, cap.chars); if (keys.length) f.keys = keys; f.at = Date.now(); changed = true; } }
        else if (o.op === 'add' && o.title && o.text) { F.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), title: String(o.title).slice(0, 30), keys, text: String(o.text).slice(0, cap.chars), at: Date.now() }); changed = true; }
      }
      if (!changed) return;
      F.sort((a, b) => (b.at || 0) - (a.at || 0)); F.length = Math.min(F.length, cap.files);
      S.mem = { files: F };
      await saveCol(memKey(), 'aidmem', { files: F, at: Date.now(), aid: charOf() });
    } catch (e) { console.error('mem write', String(e.message || e).slice(0, 160)); }
  }
  const hearing = () => !!S.guest && isHearingRole(S.role);   // たくちゃんの窓口：清掃管理のヒアリング役
  const sanbo = () => !!S.guest && isSanboRole(S.role);       // ハヤトさんの窓口：参謀（ハタボーラZ）   // たくちゃんの窓口：清掃管理のヒアリング役
  const lastFor = () => hearing() ? HEARING_LAST : AVS[S.avatar] ? AVS[S.avatar].last : JR_LAST;
  const againFor = () => hearing() ? HEARING_AGAIN : AVS[S.avatar] ? AVS[S.avatar].again : 'また来てくれたんですね。続きをお話ししましょう。';
  const av3 = (jr, hb, km) => S.avatar === 'komugi' ? km : S.avatar === 'hatabo' ? hb : jr;   // 決まった文：ジュニア・ハタボ・コムギで話し方をそろえる
  function sysParts() {
    const fixed = S.system + (S.avatar === 'hatabo' || S.avatar === 'komugi' ? CONVO_RULE : '') + (!S.guest && S.mode === 'family' ? FAMILY_RULE : '') + ((S.guest || S.mode === 'business') && S.avatar !== 'komugi' ? SERVICE_GUIDE : '') + (S.trio ? TRIO_RULE : '') + (S.lessons && S.lessons.length ? '\n\n【教わったこと（いつも守る・使う）】\n' + S.lessons.map(x => '・' + x).join('\n') : '');
    const live = (S.memo ? '\n\n【前回までの話のまとめ（ジュニアが話したこと）】\n' + S.memo : '') + memIndex() + nowLine() + (S.place ? '\n\n【いまいる場所（スマホの位置から。およそ。住所としては口に出さない）】' + S.place.text + '。「近く」はここを基準に調べる。' : '') + (S.learned && S.learned.length ? '\n\n【自分で気づいたこと（前の会話から。次から生かす）】\n' + S.learned.map(x => '・' + x).join('\n') : '');
    return [fixed, live];
  }
  function sysPrompt() { const [a, b] = sysParts(); return a + b + lastFor(); }
  // APIに渡す形：前半にキャッシュの印をつける（短すぎるときはAPIがキャッシュしないだけで、そのまま動く）
  // ハタボでは、運営の個人の名前を出さない（伝え先は、招待した人か「ハタボの事務局」）
  const tellFix = t => S.avatar === 'hatabo' && S.tellTo && !S.visit ? String(t).replace(/ハタラボの担当（ヒロさん）|ハタラボのヒロさん/g, S.tellTo).replace(/〈伝え先〉/g, S.tellTo).replace(/ヒロさん/g, S.tellTo) : t;
  function sysBlocks(extra) { const [a, b] = sysParts(); return [{ type: 'text', text: tellFix(a), cache_control: { type: 'ephemeral' } }, { type: 'text', text: tellFix((b + (S.visit || S.role === 'サービス相談' || hearing() ? '' : customBlock(S.custom)) + (extra || '') + lastFor() + (hearing() ? '' : lineupStyle(S))).trim()) || '。' }]; }
  // ハタボとコムギは、同じ人（同じLINEのID）でも話の記録・教わったことを分ける（コムギの話がハタボに出ないように）
  /* ===== IDの決まり（11/19）：キャラごとに変わるもの（会話の記録・教わったこと・気づいたこと・キャラ設定）は「持ち主×キャラ」で分ける =====
     キャラ：junior（バターちゃんジュニア）・hatabo（ハタボ）・komugi（コムギ）。ジュニアは前からの持ち主のIDのまま、ハタボは「持ち主:hatabo」、コムギは「持ち主:komugi」。
     人ごとのもの（メモ・議事録・ご縁のプロフィール・Google連携・回数・三人モード・待つ時間）は、持ち主のIDのまま（どのキャラで話しても同じ人のもの） */
  const charOf = () => S.avatar === 'komugi' ? 'komugi' : S.avatar === 'hatabo' ? 'hatabo' : 'junior';
  const charSfx = () => charOf() === 'junior' ? '' : ':' + charOf();
  const ownKey = owner => owner + charSfx();          // 持ち主×キャラ
  const convoBase = () => !S.owner || S.visit ? '' : S.guest ? S.owner + ':guest' : S.mode === 'family' ? S.owner + ':family' : '';
  const convoKey = () => { const b = convoBase(); return b ? b + charSfx() : ''; };
  /** 会話の記録を読む：持ち主×キャラ。ハタボで、まだ分ける前の記録（キャラなしのID）しかないときは、それを引きつぐ（コムギの話はあとでのぞく） */
  async function loadMyConvo() {
    const k = convoKey(); if (!k) return null;
    let c = await loadConvo(k);
    if (!c && charOf() === 'hatabo') c = await loadConvo(convoBase());
    return c;
  }
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
      if (got.length) { S.learned = mergeLearn(S.learned, got); savePrefs(ownKey(S.owner), { learned: S.learned }); }
      if (memo) S.memo = memo.slice(0, 1200);
      memWrite(talk).catch(() => {});
      S.newTurns = Math.max(0, S.newTurns - n); S.asideLog = [];
      await saveConvo(key, { summary: S.memo, newTurns: S.newTurns, turns: S.history.slice(-keepN()), at: Date.now() });
      if (diary) {
        const d = new Date(Date.now() + 9 * 3600000);
        const head = 'ジュニア日記（' + d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate() + ' ' + d.getUTCHours() + ':' + String(d.getUTCMinutes()).padStart(2, '0') + (S.me ? '・' + S.me + 'と' : '') + (S.trio ? '・三人モード' : '') + '）';
        gas(Object.assign({ action: 'note', mode: S.mode, text: head + '\n' + diary }, S.auth)).catch(e => console.error('note', String(e.message).slice(0, 120)));
      }
    } catch (e) { console.error('summarize', String(e.message || e).slice(0, 200)); }
    S.summarizing = false;
  }
  /** 馬越さんがコムギ通信を入れる：「コムギ通信に入れて：〜」の〜、なければ直前にコムギがまとめた文（なければ直前の馬越さんの言葉） */
  async function setKomugiNews(text) {
    let body = String(text).replace(/^[\s\S]*?(コムギ通信|こむぎ通信|小麦通信|速報)[^：:\n]{0,16}[：:\n]/, '').trim();
    if (body === String(text).trim() || body.length < 15) {
      const h = S.history.slice().reverse();
      const a = h.find(m => m.role === 'assistant' && String(m.content || '').length >= 30), u = h.find(m => m.role === 'user' && String(m.content || '').length >= 30);
      body = String((a && a.content) || (u && u.content) || '').trim();
    }
    if (body.length < 15) return speakOnly('入れる中身が見つからんとです。「コムギ通信に入れて」のあとに、速報の文を続けてもらえたら。', 'shy');
    await saveCol('news', 'komugi', { text: body.slice(0, 3000), at: Date.now(), by: S.owner });
    komugiCache = { at: 0, text: '' };
    send({ type: 'note_saved', kind: 'news' });
    return speakOnly('コムギ通信、入れときました。紹介の人には、うちから案内しますけん。', 'excited');
  }
  /** 窓口：会話から案件メモを作って、ヒロさんのLINEへ（GASの lead） */
  /** ハタボ事務局へ：仕様変更・不具合・改善・機能開発・企画の要望を、短くまとめて送る（ヒロさんのLINEと、あとで見返せる一覧） */
  async function feedbackNote(text) {
    const R = await loadCol('office', 'reqs'), open = (R.items || []).filter(x => x.status !== 'done').slice(0, 60);
    const recent = S.history.slice(-4).map(m => (m.role === 'user' ? (S.me || '相手') : AVS[S.avatar] ? AVS[S.avatar].name : 'AI') + '「' + String(m.content || '').slice(0, 200) + '」').join('\n');
    const r = await deps.claude.messages.create({ model: ENV.MODEL, max_tokens: 400,
      system: 'あなたはハタボ事務局の受付係。利用者の言葉から、サービスへの要望や不具合の報告だけを取り出す。想像で足さない。',
      messages: [{ role: 'user', content: '【直前の会話】\n' + (recent || '（なし）') + '\n\n【いまの言葉】\n' + text + '\n\n【すでにある要件（id：中身）】\n' + (open.map(x => x.id + '：［' + x.kind + '］' + x.title).join('\n') || '（なし）') + '\n\nJSONだけを返す：{"same":すでにある要件と同じ話ならそのid（ちがえばnull）,"is":要望や不具合の報告ならtrue（ただの雑談や、相手自身の仕事の相談ならfalse）,"kind":"不具合"か"改善"か"仕様変更"か"機能開発"か"企画"か"問い合わせ","title":"ひとことで","detail":"中身（いつ・どこで・どうなった・どうしてほしい）"}' }] });
    const t = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let j = {}; try { j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); } catch (e) { return; }
    if (!j.is) return;
    const item = { at: Date.now(), kind: String(j.kind || '改善').slice(0, 10), title: String(j.title || '').slice(0, 80), detail: String(j.detail || text).slice(0, 800), who: S.me || '', owner: S.owner || '', app: S.app, avatar: S.avatar };
    const box = await loadCol('inbox', 'feedback'); await saveCol('inbox', 'feedback', { items: [item].concat(box.items || []).slice(0, 500) });
    // 似た要件はまとめる：同じなら件数と「だれから」を足す（いちばん先に出した人が from[0]）
    const items = R.items || [], hit = j.same && items.find(x => x.id === String(j.same));
    const who0 = { ref: S.myRef || '', name: S.me || '', at: Date.now() };
    if (hit) { if (!hit.from.some(f => f.ref && f.ref === who0.ref)) hit.from.push(who0); hit.count = (hit.count || 1) + 1; hit.last = Date.now(); }
    else items.unshift({ id: Date.now().toString(36), kind: item.kind, title: item.title, detail: item.detail, count: 1, from: [who0], status: 'open', at: Date.now() });
    await saveCol('office', 'reqs', { items: items.slice(0, 400) });
    console.log('feedback', JSON.stringify(item));
    await gas(Object.assign({ action: 'lead', lead: { who: S.me, ref: 'ハタボ事務局', kind: '事務局：' + item.kind, title: item.title, need: item.detail, when: '', budget: '', next: (AVS[S.avatar] ? AVS[S.avatar].name : '') + 'のアプリから' } }, S.auth)).catch(() => {});
    await officeNote('［事務局への声：' + item.kind + '］' + (item.who || 'だれか') + 'さん（' + (AVS[S.avatar] ? AVS[S.avatar].name : '') + '）：' + item.title);
    S.feedbackSent = (S.feedbackSent || 0) + 1;
  }
  /** 事務局：要件の一覧と、採用したときのポイント（最初に出した人が半分、残りの半分をあとの人で分ける） */
  const isOffice = () => !!S.owner && ENV.OFFICE_OWNERS.some(id => S.owner === id || S.owner === 'g:' + id);
  async function onReqs(m) {
    if (!isOffice()) return send({ type: 'reqs', denied: true });
    const R = await loadCol('office', 'reqs'), items = R.items || [];
    if (m.type === 'req_adopt') {
      const it = items.find(x => x.id === String(m.id)), pts = Math.max(0, Math.min(100000, Math.round(Number(m.pts) || 0)));
      if (it && it.status !== 'done' && pts) {
        const [first, ...rest] = it.from || [], shares = rest.length ? [[first, Math.round(pts / 2)]].concat(rest.map(f => [f, Math.floor(pts / 2 / rest.length)])) : [[first, pts]];
        for (const [f, pt] of shares) {
          if (!f || !f.ref || !pt) continue;
          const r = await getRef(f.ref).catch(() => null) || {};
          await putRef(f.ref, { pts: (r.pts || 0) + pt });
          await postInbox(f.ref, { kind: 'goen', from: 'office', fromName: 'ハタボ事務局', text: 'あなたの声「' + it.title + '」が採用されました。ありがとうポイント +' + pt + 'pt' });
        }
        it.status = 'done'; it.pts = pts; it.doneAt = Date.now();
        await saveCol('office', 'reqs', { items });
      }
    }
    send({ type: 'reqs', items: items.slice(0, 200).sort((a, b) => (a.status === 'done') - (b.status === 'done') || (b.count || 1) - (a.count || 1)) });
  }
  /** 資料フォルダ：本人（馬越さん）は設定と共有のオン・オフ、紹介先は共有された資料の一覧と「自分のドライブに入れる」 */
  async function onDocs(m) {
    const owner = S.macSelf ? S.owner : macOwnerKey();
    if (!S.macSelf && !S.bridge) return send({ type: 'docs', none: true });
    if (S.macSelf && m.type === 'docs_set') { const r = await docsSync(S.owner, m.url || ''); if (r.error) return send({ type: 'docs', error: r.error }); }
    let d = await docsLoad(owner);
    if (S.macSelf && m.type === 'docs_share') { (d.files || []).forEach(f => { if (f.id === m.id) f.share = !!m.on; }); await saveCol(DOCS_KEY(owner), 'docs', { files: d.files }); }
    if (S.bridge && m.type === 'docs_copy') {
      const f = (d.files || []).find(x => x.id === m.id && x.share);
      const link = f ? await driveSave(S.owner, f.name + '（' + '馬越さんの資料）', f.text).catch(() => null) : null;
      send({ type: 'links', links: link ? [{ title: '自分のドライブに入れました：' + f.name, url: link.url || link }] : [] });
      if (!link) return send({ type: 'docs', error: 'google' });
    }
    if (m.type !== 'docs' && S.macSelf) { S.system = S.system.replace(/\n\n【馬越さんの資料[\s\S]*?(?=【いま話している人】)/, ''); S.system = docsBlock(d, false) + S.system; }
    const files = (d.files || []).filter(f => S.macSelf || f.share).map(f => ({ id: f.id, name: f.name, share: !!f.share, ok: !!f.text }));
    send({ type: 'docs', mine: !!S.macSelf, folderUrl: S.macSelf ? d.folderUrl || '' : '', files, at: d.at || 0 });
  }
  async function leadNote() {
    const key = convoKey();
    if (!key || S.summarizing || S.newTurns < 1 || S.macSelf) return;
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
      if (S.asGuest && !hearing() && Array.isArray(j.learn)) { const got = pickLearn(j.learn.join('\n')); if (got.length) { S.learned = mergeLearn(S.learned, got); savePrefs(GUEST_COMMON, { learned: S.learned }); } }
      S.newTurns = Math.max(0, S.newTurns - n);
      await saveConvo(key, { summary: S.memo, newTurns: S.newTurns, turns: S.history.slice(-keepN()), at: Date.now() });
      memWrite(talk).catch(() => {});
      if (hearing()) hearingPush(talk).catch(e => console.error('hearing push', String(e.message || e).slice(0, 120)));
      if (sanbo()) sanboPush(talk).catch(e => console.error('sanbo push', String(e.message || e).slice(0, 120)));
      if (j.worth && !sanbo()) {
        const slot = S.slots.find(x => j.slot && (x.label === j.slot || String(j.slot).indexOf(x.label) >= 0)) || null;
        const lead = { who: S.me, ref: await refLabel(S.refFrom || S.ref || ''), kind: String(j.kind || ''), title: String(j.title || ''), need: String(j.need || ''), when: String(j.when || ''), budget: String(j.budget || ''), next: String(j.next || ''), slot };
        if (S.introducer === 'mac') lead.introducer = '馬越さん（コムギ）';
        const g = await gas(Object.assign({ action: 'lead', lead }, S.auth));
        if (!g || !g.ok) console.error('lead ng', JSON.stringify(g).slice(0, 200));
        if (S.avatar === 'komugi') {      // コムギの橋渡し：案件メモを馬越さんにも（伝言とLINE）
          const text = '【コムギから】' + (S.me || 'ご縁の人') + 'さん：' + [lead.title, lead.need && 'してほしいこと：' + lead.need, lead.when && 'いつ：' + lead.when, lead.budget && '予算：' + lead.budget, lead.next && 'つぎ：' + lead.next].filter(Boolean).join('／');
          for (const c of macRefs()) await postInbox(c, { kind: 'msg', from: S.myRef, fromName: S.me || 'ご縁の人', text }, 'komugi').catch(() => {});
        }
      }
    } catch (e) { console.error('lead', String(e.message || e).slice(0, 200)); }
    S.summarizing = false;
  }
  /** 参謀：本人が「ヒロさんに」と言ったか、「送りますか？」にOKしたことだけを、ヒロさんのLINEに届ける。ほかは届けない */
  async function sanboPush(talk) {
    const r = await deps.claude.messages.create({
      model: ENV.MODEL, max_tokens: 700,
      system: 'あなたはヒロさんの記録係。会話の中で、相手が「ヒロさんに伝えて」と言ったこと、またはAIの「ヒロさんに送りますか？」に相手がはい・OKと答えたことだけを取り出す。それ以外（個人的な話、OKのない話）は絶対に入れない。想像で足さない。',
      messages: [{ role: 'user', content: '【会話】\n' + talk + '\n\nJSONだけを返す：{"items":["ヒロさんに届ける中身を1件ずつ、短く（案件名・してほしいこと・期限があれば）"]}。届けるものがなければ {"items":[]}' }]
    });
    const t = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let j = {}; try { j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); } catch (e) { return; }
    const items = (Array.isArray(j.items) ? j.items : []).map(x => String(x).trim()).filter(Boolean).slice(0, 8);
    if (!items.length) return;
    await officePush('【参謀から】' + (S.me || 'ハヤト') + 'さん' + (S.asGuest ? '（テスト）' : '') + '\n' + items.map(x => '・' + x).join('\n'));
  }
  /** 清掃ヒアリング：聞けたことをまとめて、ヒロさん（事務局）のLINEにすぐ届ける */
  async function hearingPush(talk) {
    const r = await deps.claude.messages.create({
      model: ENV.MODEL, max_tokens: 700,
      system: 'あなたはヒロさんの記録係。清掃管理の作り直しのヒアリングで、相手が答えたことだけを、ヒロさん向けに短くまとめる。想像で足さない。記号は「・」だけ。',
      messages: [{ role: 'user', content: '【これまでのまとめ】\n' + (S.memo || '（なし）') + '\n\n【新しい会話】\n' + talk + '\n\n次の形で、200〜400字で書く：\n共有：（表とGASを共有してもらえるか）\n確認できたこと：\n新しくわかったこと：\nまだ聞けていないこと：' }],
    });
    const t = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!t) return;
    await officePush('【清掃管理のヒアリング】' + (S.me || 'たくちゃん') + 'さん' + (S.asGuest ? '（テスト）' : '') + '\n' + t);
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
    if (!text) return speakOnly(S.history.length ? againFor() : (AVS[S.avatar] ? greetFor() : guestGreeting(S.me)), 'excited');
    S.history.push({ role: 'user', content: '（ページを開いた）' }, { role: 'assistant', content: text });
    speakOnly(text, 'excited');
  }
  /** 「〜を覚えて」：教わったことを持ち主ごとに覚える（30こまで。家族だけ） */
  function learn(text) {
    const fact = String(text).replace(/^(ジュニア|じゅにあ)[、,\s]*/, '').replace(/(を|って)?(覚えて|おぼえて|忘れないで|わすれないで|覚えといて|おぼえといて)(おいて|ね|な|くれ|ください|くんな)*[。！!]*$/, '').replace(/^(覚えて|おぼえて|覚えといて|おぼえといて)[：:、]\s*/, '').trim().slice(0, 120);
    if (!fact) return speakOnly(av3('何を覚えればいいですか？', '何を覚えればいいですか？', '何を覚えたらよかですか？'), 'think');
    S.lessons = (S.lessons || []).filter(x => x !== fact).concat(fact).slice(-30);
    savePrefs(S.asGuest ? GUEST_COMMON : ownKey(S.owner), { lessons: S.lessons });
    return speakOnly(av3('覚えました。次から生かしますね。', '覚えました。次から生かします。', isMac(S.owner) ? '覚えました。紹介の人と話すうちにも、ちゃんと生かしますけん。' : '覚えました。次から、ちゃんと生かしますけん。'), 'excited');
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
      else { await saveCol(S.myRef, 'friends', { out: [...mine.out, other] }); await saveCol(other, 'friends', { inbox: [S.myRef, ...theirs.inbox.filter(x => x !== S.myRef)].slice(0, 50) }); postInbox(other, { kind: 'goen', from: S.myRef, fromName: who, text: who + 'さんから、AI棒の友だち申請がとどきました。Myハタボの「友だち」で承認できます。' }).catch(() => {}); }
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
    if (r.introducer || S.introducer) { patch.introducer = r.introducer || S.introducer; patch.fee = { introducer: patch.introducer, lineup: m.lineup || r.lineup || '', grade: g || r.grade || '', price: (L && L.grades[g]) || '', pay, at: now, act }; }   // 紹介の手数料をあとで数えるための記録
    await putRef(S.myRef, patch);
    S.funnel = funnelOf(Object.assign({}, r, patch));
    const f = S.funnel, title = kind + '：' + (f.lineupName || '') + ' ' + (f.grade || '') + (f.price ? '（' + f.price + (f.pay === 'y' ? '・年払い' : '・月払い') + '）' : '');
    console.log('funnel', JSON.stringify({ owner: S.owner, name: S.me, act, lineup: f.lineup, grade: f.grade, pay: f.pay, introducer: patch.introducer || '' }));
    if (patch.introducer === 'mac' && (act === 'trial' || act === 'contract')) for (const c of macRefs()) postInbox(c, { kind: 'goen', from: S.myRef, fromName: S.me || 'ご縁の人', text: (S.me || 'ご縁の人') + 'さんが、コムギ（馬越さん）の紹介で' + (act === 'trial' ? 'ハタボのお試しをはじめました：' : 'ハタボを契約しました：') + title }, 'komugi').catch(() => {});
    gas(Object.assign({ action: 'lead', lead: { who: S.me, ref: await refLabel(S.refFrom || S.ref || ''), kind: '契約', title, need: kind, when: f.stage === 'trial' ? new Date(f.trialUntil).toLocaleDateString('ja-JP') + 'までお試し' : '', budget: f.price || '', next: act === 'cancel' ? 'お試しをやめた理由を聞く' : 'お支払いの登録を案内する', memo: '' } }, S.auth)).catch(() => {});
    if (act === 'trial') tellUpline(S, 'お試し（' + (f.lineupName || '') + '）をはじめました', 'trial').catch(() => {});
    if (act === 'contract') { tellUpline(S, (f.lineupName || '') + ' ' + (f.grade || '') + 'を契約しました', 'contract').catch(() => {}); putRef(S.myRef, { thanked: true }).catch(() => {}); }
    send(await myPage(S));
    const say = { trial: '7日間のお試しがはじまったボー！いちばん上のZで動くから、なんでも頼んでほしいボー。', change: 'プランを変えたボー。', cancel: 'お試しをやめたボー。また話したくなったら、いつでも呼んでほしいボー。', contract: 'お申し込みありがとうだボー！お支払いの案内は、ハタラボから届くボー。' }[act];
    if (say) speakOnly(S.avatar === 'komugi' ? say.replace(/だボー/g, 'です').replace(/ボー/g, 'です') : S.avatar === 'hatabo' ? say : bizBo(say), act === 'cancel' ? 'shy' : 'excited');
  }
  /** 伝言：「〇〇さんに、△△って伝えて」。ご縁でつながった人のハタボに届ける */
  async function dengon(text) {
    const people = await goenPeople(S.myRef).catch(() => []);
    const hit = people.filter(p => p.name && text.indexOf(String(p.name).replace(/さん$/, '')) >= 0).sort((a, b) => b.name.length - a.name.length)[0];
    const T = S.avatar === 'komugi' ? x => x.replace(/ボー/g, 'です') : S.avatar === 'hatabo' ? bizBo : bizBo;
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
    const T = S.avatar === 'komugi' ? x => x.replace(/だボー/g, 'です').replace(/ボー/g, 'です') : S.avatar === 'hatabo' ? bizBo : bizBo;
    const lines = un.slice(0, 3).map(x => x.kind === 'goen' ? x.text : x.fromName + 'さんから：「' + String(x.text).slice(0, 120) + '」');
    await speakOnly(T('伝言が' + un.length + '件あるボー。' + lines.join('　') + (un.length > 3 ? '　ほかはMyハタボの伝言で見られるボー。' : '')), 'excited');
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
      speakOnly(S.avatar === 'komugi' ? 'メモ、しときました。Myハタボの「メモ・議事録」で、見られますけん。' : S.avatar === 'hatabo' ? 'メモしました。Myハタボの「メモ・議事録」で見られます。' : 'メモしました。Myハタボの「メモ・議事録」で見られます。', 'smile');
    } catch (e) { speakOnly('ごめん、メモがうまく残せなかった。', 'sad'); }
  }
  /** 議事録：いままでの話をまとめて、GASでPDFにしてドライブへ。リンクを吹き出しに出す */
  async function minutes(pdf) {
    speakOnly(pdf ? '議事録をまとめてPDFにします。少し待ってくださいね。' : '議事録をまとめておきます。少し待ってくださいね。', 'think');
    const talk = S.history.slice(-24).map(m => (m.role === 'user' ? (S.me || 'みんな') : 'ジュニア') + '：' + (typeof m.content === 'string' ? m.content : '（写真）')).join('\n')
      + (S.asideLog.length ? '\n（まわりで聞こえた会話）\n' + S.asideLog.join('\n') : '');
    if (!talk.trim()) return speakOnly(av3('まだまとめる話がありません。もう少し話してからにしましょう。', 'まだまとめる話がありません。もう少し話してからにしましょう。', 'まだまとめるお話がなかとです。もう少しお話ししてからにしましょう。'), 'shy');
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
      if (S.guest) { send({ type: 'note_saved', kind: 'minutes' }); return speakOnly(S.avatar === 'komugi' ? '議事録、Myハタボの「メモ・議事録」に、残しときました。' : '議事録をまとめて、Myハタボの「メモ・議事録」に残したボー！', 'excited'); }
      const g = await gas(Object.assign({ action: 'minutes', mode: S.mode, pdf: !!pdf, title: day + ' ' + title, text: t }, S.auth));
      if (!g || !g.ok || !g.url) throw new Error((g && (g.detail || g.error)) || 'minutes');
      send({ type: 'links', links: [{ title: (pdf ? '議事録（PDF）：' : '議事録：') + title, url: g.url }] });
      S.brainAt = 0;      // つぎの返事から、議事録も読んだ記録で話す
      speakOnly(pdf ? '議事録のPDFができました。吹き出しのリンクから開いてくださいね。' : '議事録を残しておきました。お兄さん分のバターちゃんも読めるので、続きはどちらでも話せますよ。', 'excited');
    } catch (e) { console.error('minutes', String(e.message).slice(0, 200)); speakOnly(av3('ごめんなさい、議事録がうまく作れませんでした。', '議事録がうまく作れませんでした。もう一度お願いします。', '議事録がうまく作れんかったです。もう一度お願いします。'), 'sad'); }
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
    return speakOnly(on ? '三人モードにします。ぼくに話すときは「ジュニア」と呼んでくださいね。' : 'ふつうのモードにもどします。', 'excited');
  }
  function greetFor() {
    if (hearing()) return hearingHello(S.me);
    if (S.avatar !== 'hatabo') return AVS[S.avatar].greet(S.me);
    const cm = S.custom && S.custom.callMe;
    if (!cm) S.askName = true;
    if (/^セミナー/.test(S.role)) return 'ようこそだボー' + (cm ? '、' + cm : '') + '。ぼくはマーケティングのセミナー担当、ハタボだボー。今日は' + (S.role.indexOf('パートナー') >= 0 ? 'パートナー向け説明会で、紹介のしかたと報酬、ご縁とポイントの話' : '事業主・法人向け説明会で、ハタボでできることと、お店や会社での使い方') + 'を、いっしょに見ていくボー。まずは、' + (S.role.indexOf('パートナー') >= 0 ? 'どんな人にハタボを紹介したいか' : 'いまのお仕事と、いちばん困っていること') + 'を教えてほしいボー。';
    return hataboHello(cm, S.role === 'サービス相談', S.me);
  }
  /** 「なんて呼べばいい？」への答えから呼び名を取り出す（〜でいいよ・〜って呼んで・〜です） */
  function pickCallName(t) {
    let x = String(t || '').replace(/[。、！!？?\s]/g, '').replace(/^(ぼくは|ぼくの名前は|わたしは|私は|俺は|おれは|うちは|名前は|なまえは)/, '');
    x = x.replace(/(って|と)?(呼んで|よんで)(ください|ほしい|ね|よ)?$/, '').replace(/(で|が)?(いい|良い|OK|おっけー|オッケー)(です|よ|かな|な)?$/, '').replace(/(です|だよ|でーす|っす|と申します|といいます|と言います|でお願いします|でおねがいします)$/, '');
    return x.length >= 1 && x.length <= 12 ? x : '';
  }
  async function onHeard(text) {
    if (S.avatar === 'hatabo' || S.avatar === 'komugi' || S.app) text = hearFix(text);
    S.lastPartial = Date.now(); S.utt++;
    if (S.askName && S.avatar === 'hatabo' && !S.visit) {
      S.askName = false;
      const yes = /^(うん|はい|いいよ|それで(いい|OK)|OK|オッケー|おっけー|大丈夫|だいじょうぶ|そう)[。！!、\s]*(だよ|です|よ)?[。！!]*$/i.test(String(text).trim());
      const nm = yes && S.me ? S.me + 'さん' : pickCallName(text);
      if (nm && S.owner) {
        S.custom = Object.assign(cleanCustom(S.custom || {}), { callMe: nm }); savePrefs(ownKey(S.owner), { custom: S.custom }).catch(() => {});
        return speakOnly(nm + '、ですね。覚えました。' + (S.role === 'サービス相談' ? 'ハタボについて、知りたいことはありますか？' : 'それでは、' + nm + 'がいま困っていることや、うまくいっていないことはありますか？'), 'excited');
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
        return speakOnly(PACE_SLOW.test(text) ? 'わかりました。次からもう少し待ってから話しますね。' : 'わかりました。次からすぐ答えますね。', 'smile');
      }
    }
    if (S.app && FEEDBACK_RE.test(text)) feedbackNote(text).catch(e => console.error('feedback', String(e.message).slice(0, 120)));   // 仕様変更・不具合・改善・機能・企画の声は、ハタボ事務局へ（返事はふつうに続ける）
    if ((!S.guest || S.asGuest || S.macSelf) && wantsLearn(text)) return learn(text);
    if ((!S.guest || S.asGuest || S.macSelf) && FORGET_RE.test(text)) { S.lessons = []; S.learned = []; savePrefs(S.asGuest ? GUEST_COMMON : ownKey(S.owner), { lessons: [], learned: [] }); return speakOnly(av3('教わったことは、ぜんぶ忘れました。また一から教えてくださいね。', '教わったことは、ぜんぶ忘れました。また一から教えてください。', '教わったことは、ぜんぶ忘れました。また一から教えてくださいね。'), 'smile'); }
    if (S.macSelf && isMac(S.owner) && NEWS_SET_RE.test(text)) return setKomugiNews(text);   // コムギ通信を入れられるのは馬越さんだけ（「馬越さんより」として紹介の人に届くので）
    if (MINUTES_RE.test(text)) return minutes(PDF_RE.test(text) && !S.guest);
    if (MEMO_RE.test(text)) return memo(text);
    if (S.myRef && DENGON_RE.test(text) && await dengon(text)) return;
    if (calledJunior(text) && nameOnly(text)) return speakOnly(AVS[S.avatar] ? AVS[S.avatar].quick : QUICK[Math.floor(Math.random() * QUICK.length)], 'smile');
    if (KAKEGOE_RE.test(text)) return speakOnly(S.guest || S.mode === 'business' ? KAKEGOE_GUEST : KAKEGOE_FAMILY, 'excited');
    if (QUIET_RE.test(text)) { S.quiet = true; send({ type: 'quiet', on: true }); return speakOnly(av3('静かにしていますね。用があったら名前を呼んでください。', '静かにしています。用があったら名前を呼んでください。', '静かにしときます。用があったら名前を呼んでくださいね。'), 'smile'); }
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
    if (typeof text === 'string' && S.avatar === 'hatabo') text = bizBo(text);   // ハタボはていねいな言葉で
    stopReply('new');
    const gen = S.gen; S.speaking = true;
    send({ type: 'reply_start', gen, emotion, as: as || 'ジュニア', nobubble: !!nobubble });
    try { send({ type: 'audio', gen, seq: 0, text, mp3: await synth(text, S.voice, emotion, null, S.rateMul) }); } catch (e) { send({ type: 'notice', why: 'tts', detail: String(e.message).slice(0, 80) }); }
    if (gen === S.gen) { send({ type: 'reply_end', gen, emotion, text }); S.speaking = false; }
  }
  async function reply(content, logText, as) {
    const jam = as === 'jam';
    const voice = jam ? JAM_VOICE : S.voice;
    if (!S.asGuest && !superUntil(S.owner) && !hearing() && !sanbo() && (!quotaOk(S.owner || 'anon', S.guest && !S.claude, !!S.refFrom, gradeCap(S)) || !familyOk(S)) && !(await useTicket())) { send({ type: 'limit', why: 'plan' }); return speakOnly(S.avatar === 'hatabo' ? 'きょう話せる回数がいっぱいになったボー。チケットを足すと、このまま続けられるボー。' : S.avatar === 'komugi' ? 'すみません……きょう話せる回数、いっぱいになってしもうたとです。チケットを足してもらえたら、このまま続けられますけん。' : S.guest ? 'ごめんなさい、きょうここで話せる回数がいっぱいになりました。続きはヒロさんに伝えておくので、また明日お話ししましょう。' : 'きょう話せる回数がいっぱいになりました。また明日お話ししましょうね。', 'shy'); }
    bumpStats(S);
    if (!S.asGuest && S.funnel && S.funnel.stage === 'trial' && (counts.get((S.owner || 'anon') + ':' + new Date().toISOString().slice(0, 10)) || 0) > trialCap(S.funnel) && !(await useTicket()) && (send({ type: 'limit', why: 'trial' }) || true))
      return speakOnly(S.avatar === 'komugi' ? 'お試しは、' + TRIAL_TEXT + 'なんです……。また明日、お話ししましょう。' : 'お試しのZは' + TRIAL_TEXT + 'だボー。また明日話そうボー。', 'shy');
    if (Date.now() - (S.brainAt || 0) > 10 * 60 * 1000) { try { await loadBrain(true); } catch (e) {} }   // 記録は10分ごとに読みなおす
    let noRecord = false;
    if (MAIL_RE.test(logText || '')) {
      const mails = await mailNote();
      if (mails) {
        noRecord = true;          // メールの中身は、会話の記録・日記に残さない
        const box = mails.length ? mails.map((x, i) => (i + 1) + '. ' + x.from + '「' + x.subject + '」' + (x.snippet ? '：' + x.snippet : '')).join('\n') : '（未読のメールはない）';
        content = [{ type: 'text', text: '【ヒロさんの受信トレイの未読（新しい順・最大5通）。ヒロさんにだけ短く伝える】\n' + box + '\n\n【ヒロさんの言葉】\n' + logText }];
      } else {
        return speakOnly('ごめんなさい、メールはヒロさんにしか見せられません。', 'shy');
      }
    }
    stopReply('new');
    const gen = S.gen, utt0 = S.utt; S.speaking = true;
    const ac = new AbortController(); S.aborter = ac;
    const plan = planOf(S);
    const deluxe = !!(S.macSelf || (S.app && !S.bridge && superUntil(S.owner)));   // 馬越さんのコムギと、検証中のハタボ（制限なしの人）は、バターちゃん級：前の話を長く覚えて、返事も長め
    let msgs = cleanTurns(S.history).slice(-(deluxe ? 40 : plan.turns)).concat([{ role: 'user', content }]);
    const use = { model: '', inTok: 0, outTok: 0, cacheTok: 0, searches: 0 };
    let full = '', emotion = 'smile', head = true, seq = 0, chain = Promise.resolve();
    const tm = { t0: Date.now(), tok: 0, audio: 0 }, tv = {};   // 速さの記録（中身は残さない）
    send({ type: 'reply_start', gen, as: jam ? 'ジャム猫' : !S.visit && S.custom && S.custom.aiName ? S.custom.aiName : AVS[S.avatar] ? AVS[S.avatar].name : 'ジュニア' });
    if (S.placeP) { await S.placeP.catch(() => {}); S.placeP = null; }
    const study = !jam && !S.guest && S.mode === 'family' && STUDY_RE.test(logText || '');
    const route = jam ? { smart: false, search: false } : needSmart(logText, S.guest);
    if (study) route.smart = true;                  // 勉強は賢いモデルで、ていねいに
    if (S.bridge && !(S.funnel && (S.funnel.stage === 'trial' || S.funnel.stage === 'contract'))) { route.search = false; route.smart = false; }   // コムギの橋渡しは短く・軽く（お試し・契約したらふつうに）
    const claudeMode = !!(plan === PLANS.super && !jam && !S.trio && !S.visit);   // Z（スーパー上位）は、だれでもClaudeと同じ精度で答える
    const longMode = !!(plan.long && !jam && !S.trio && S.role !== 'サービス相談' && !(S.bridge && !(S.funnel && S.funnel.stage)) && (claudeMode || LONG_RE.test(logText || '')));
    const maxSent = (S.trio ? 2 : study ? 5 : route.search ? 4 : 3) + (S.trio ? 0 : plan.extraSent) + (S.firstDay && S.avatar === 'hatabo' ? 3 : 0) + (deluxe ? 1 : 0);   // 初日は、サービスの説明ができるように声も長めに
    let capped = false, spoken = '';
    const sp = splitter(sentence => {
      let s = clean(sentence).trim();
      if (S.avatar === 'hatabo') s = bizBo(s);
      if (seq === 0 && (S.avatar === 'komugi' || S.avatar === 'hatabo')) s = s.replace(/^(?:(?:うん|うんうん|ううん|ん|ええ|ええと|えっと|あ|ああ|あの|あのう|うう)[、。…！!？?\s]+)+/, '').trim();   // コムギ：返事のはじめの「うん」などは読まない
      if (!s || capped) return;
      if (seq >= maxSent) { capped = true; return; }      // 三人モードは2文まで
      spoken += s;
      const n = seq++;
      const p = synth(s, voice, emotion, n === 0 ? tv : null, S.rateMul).catch(() => jam ? synth(s, S.voice) : Promise.reject(new Error('tts'))).catch(e => { send({ type: 'notice', why: 'tts', detail: String(e.message).slice(0, 80) }); return ''; });
      chain = chain.then(async () => { const mp3 = await p; if (n === 0) await waitQuiet(gen, utt0); if (gen === S.gen && mp3) { if (n === 0) tm.audio = Date.now(); send({ type: 'audio', gen, seq: n, text: s, mp3 }); } });
    });
    let lastErr = '';
    const links = [], seenUrl = new Set();
    const addLink = (url, title, cited) => { if (!url || seenUrl.has(url)) return; seenUrl.add(url); links[cited ? 'unshift' : 'push']({ url: String(url).slice(0, 500), title: String(title || url).slice(0, 80) }); };
    if (route.search) msgs = msgs.slice(-6);      // 調べるときは、最近の話だけ（速く・確かに）
    let pauses = 0, cut = false, listenOnly = false;
    for (let attempt = 0; attempt < 3; attempt++) {
    let stopReason = '';
    try {
      // 2回目は、それまでの会話をつけずに聞く（会話の記録がこわれていても答えられるように）
      // 1回目：必要なら賢いモデル＋検索。だめなら2回目は速いモデルだけ（検索なし・会話の記録なし）
      // 1回目：必要なら賢いモデル＋検索（場所つき）。2回目：検索だけもう一度（場所の設定なし）。3回目：速いモデルだけ
      const useSmart = route.smart && attempt < 2, useSearch = route.search && attempt < 2 && ENV.WEB_SEARCH;
      const params = {
        model: plan.premium && attempt < 2 && !jam ? ENV.PREMIUM_MODEL : (useSmart || (plan.smart && attempt < 2 && !jam)) ? ENV.SMART_MODEL : ENV.MODEL,
        max_tokens: (deluxe ? 600 : 0) + (S.trio ? 240 : study ? 520 : S.mode === 'business' ? 340 : 320) + (useSearch ? 400 : 0) + (S.trio ? 0 : plan.extraTokens) + (longMode ? 3500 : 0) + (S.firstDay && S.avatar === 'hatabo' ? 400 : 0),
        system: sysBlocks(memPick(logText) + (claudeMode && !LONG_RE.test(logText || '') ? CLAUDE_RULE : longMode ? LONG_RULE : plan === PLANS.high && !jam && !S.trio ? HIGH_RULE : '') + (study ? STUDY_RULE : '') + (jam ? JAM_RULE : '') + (route.search && !useSearch ? '\n\n【いまは調べられない】検索が使えないので、今の情報は「ごめんなさい、いまは調べられません」と正直に言う。' : '')),
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
        if (!tm.tok) tm.tok = Date.now();
        full += t;
        if (head) {                                   // 先頭の [わくわく] を気持ちにして、読み上げない
          const probe = full.trimStart();
          if (/^[\[［]聞くだけ/.test(probe)) { listenOnly = true; try { ac.abort(); } catch (e) {} break; }   // 自分あてではない：声に出さない
          if (/^[\[［]/.test(probe) && !/[\]］]/.test(probe)) continue;
          const e = takeEmotion(probe);
          if (e) { emotion = e.emotion; t = e.rest; send({ type: 'emotion', gen, emotion }); } else t = probe;
          head = false;
        }
        if (capped && !longMode) { try { ac.abort(); } catch (e) {} break; }   // 長文のときは、声は止めても吹き出しには最後まで出す
        send({ type: 'reply_text', gen, text: t });
        sp.push(t);
      }
      if (listenOnly) break;
      // 調べものが長いと、AIがいったん区切って返す（pause_turn）。そのときは続きをもらう（2回まで）
      if (stopReason === 'pause_turn' && pauses < 2 && gen === S.gen && !capped && typeof stream.finalMessage === 'function') {
        const fm = await stream.finalMessage();
        msgs = msgs.concat([{ role: 'assistant', content: fm.content }]);
        pauses++; attempt--; continue;
      }
      // 返事が空っぽ：もう一度（2回目は場所なしの検索、3回目は速いモデルだけ）
      if (!clean(full).trim() && gen === S.gen && !capped) {
        console.error('empty reply', attempt, stopReason || '-');
        if (stopReason === 'max_tokens' && THINK.i < THINK.modes.length - 1 && deps.claude && !deps.claude.fake) { THINK.i = THINK.modes.length - 1; console.error('thinking mode → (なし・枠を広げる)'); }   // 考えるだけで枠を使いきったら、次は余白つきで
        if (attempt < 2) { lastErr = 'empty ' + (stopReason || '-'); continue; }
        send({ type: 'notice', why: 'empty', detail: stopReason || '-' });
      }
      if (stopReason === 'max_tokens') { sp.drop(); cut = true; } else sp.end();   // 上限で切れたときは、とちゅうの文を読まない
      await chain;
      break;
    } catch (e) {
      if (capped || listenOnly || gen !== S.gen) break;
      lastErr = String(e.message || e);
      console.error('ai error', attempt, lastErr.slice(0, 300));
      thinkNext(e);
      // 賢いモデルや検索がこのキーで使えないときは、次からは使わない（毎回失敗しないように）
      if (route.search && /(not enabled|not allowed|disabled|permission)/i.test(lastErr) && /web/i.test(lastErr)) { ENV.WEB_SEARCH = false; console.error('web search off'); }
      if (attempt === 0 && route.smart && /model/i.test(lastErr) && /not_found|invalid|does not exist/i.test(lastErr)) { ENV.SMART_MODEL = ENV.MODEL; console.error('smart model off'); }
      if (attempt === 0 && plan.premium && /model/i.test(lastErr) && /not_found|invalid|does not exist/i.test(lastErr)) { ENV.PREMIUM_MODEL = ENV.SMART_MODEL; console.error('premium model off'); }
      if (full || attempt === 2) { send({ type: 'notice', why: 'ai', detail: lastErr.slice(0, 120) }); break; }
      await new Promise(r => setTimeout(r, 400));
    }
    }
    if (gen !== S.gen) return;
    if (listenOnly) {   // 自分あてではなかった：声に出さず、話の流れとしてだけ覚える
      if (logText && !noRecord) S.history.push({ role: 'user', content: '（まわりの会話・自分あてではない）' + logText }, { role: 'assistant', content: '（聞いていた）' });
      send({ type: 'reply_end', gen, emotion, text: '', listen: true });
      S.speaking = false; S.aborter = null;
      return;
    }
    let text = capped && !longMode ? spoken : clean(full).trim();
    if (S.avatar === 'hatabo') text = bizBo(text);
    if ((S.avatar === 'komugi' || S.avatar === 'hatabo')) text = text.replace(/^(?:(?:うん|うんうん|ううん|ん|ええ|ええと|えっと|あ|ああ|あの|あのう|うう)[、。…！!？?\s]+)+/, '').trim();
    if (cut && !capped) { const k = Math.max(text.lastIndexOf('。'), text.lastIndexOf('！'), text.lastIndexOf('？'), text.lastIndexOf('!'), text.lastIndexOf('?')); if (k > 0) text = text.slice(0, k + 1); }
    if (text && !noRecord) S.history.push({ role: 'user', content: logText || '（写真を見せた）' }, { role: 'assistant', content: text });
    if (text && !noRecord && logText) faqLog(S.role, logText, text).catch(() => {});
    if (S.visit && logText) S.visitLog.push(String(logText).slice(0, 200));
    // ハタボの話が出たら、ときどき（8回に1回まで）サービスサイトへの道をそえる（声では読まない）
    S.replyN = (S.replyN || 0) + 1;
    // 話題のページ：ハタボ・コムギが、サービスのことやMyハタボのことを話したら、そのページを出す（同じページは6回に1回まで）
    if (text && !hearing() && (S.avatar === 'komugi' || S.avatar === 'hatabo')) {
      S.topicAt = S.topicAt || {};
      for (const l of topicLinks(text, S.avatar === 'komugi' ? LINE_CH.komugi.mini : HATABO_MINI)) {
        if (S.replyN - (S.topicAt[l.url] || -99) < 6) continue;
        S.topicAt[l.url] = S.replyN; links.push(l); if (!l.page) S.siteAt = S.replyN;
      }
    }
    if (text && S.guest && !hearing() && (S.avatar === 'komugi' || S.avatar === 'hatabo') && /ハタボ/.test(text) && S.replyN - (S.siteAt || -99) >= 8) {
      S.siteAt = S.replyN;
      if (S.bridge && S.avatar !== 'komugi') links.push({ url: HATABO_MINI, title: '自分のハタボと話す（ハタボの公式LINEを友だち追加）' });   // コムギは、いったんハタボの公式LINEを出さない（サービスサイトだけ）
      links.push({ url: (ENV.SITE_URL || 'https://www.hatha-lab.com'), title: 'ハタボのサービスサイトを見る' });
    }
    if (links.length && text) send({ type: 'links', gen, links: links.slice(0, 3) });
    if (longMode && text && text.length > 200 && S.owner) addNote(S.owner, { kind: 'doc', title: (logText || '書いた文章').replace(/\s+/g, ' ').slice(0, 30), text }).then(() => send({ type: 'note_saved', kind: 'doc' })).catch(() => {});
    if (S.trio && /[？?]\s*$/.test(text)) S.followUntil = Date.now() + 12000;   // ジュニアが質問した → つぎの1回は名前なしでも   // 空の返事は記録しない（次の会話がこわれるので）
    { const kp = S.macSelf || (S.app && !S.bridge && superUntil(S.owner)) ? 80 : plan.keep; if (S.history.length > kp) S.history = S.history.slice(-kp); }
    // 人ごとのAI代（獲得コストを後で出すため）：LINEのIDの紹介コードに足していく（円・1ドル150円）
    { const P = /opus/.test(use.model) ? [4, 20, 0.2] : /sonnet/.test(use.model) ? [2, 10, 0.1] : /haiku-5/.test(use.model) ? [0.1, 0.5, 0.01] : [1, 5, 0.1];
      const yen = ((use.inTok * P[0] + use.outTok * P[1] + use.cacheTok * P[2]) / 1e6 + use.searches * 0.01) * 150 + (spoken.length || 0) * 0.0045 + 0.4;
      if (S.myRef) { S.costYen = (S.costYen || 0) + yen; const mon = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7);
        S.costMonYen = (S.costMon === mon ? S.costMonYen || 0 : 0) + yen; S.costMon = mon;   // 今月のAI代（Myハタボの使用量メーター用）
        putRef(S.myRef, { costYen: Math.round(S.costYen * 10) / 10, costMon: mon, costMonYen: Math.round(S.costMonYen * 10) / 10, costAt: Date.now() }).catch(() => {}); } }
    const usage = plan === PLANS.std && !S.plan ? undefined : { plan: plan.label, model: use.model, in: use.inTok, out: use.outTok, cache: use.cacheTok, searches: use.searches };
    if (usage) console.log('plan usage', JSON.stringify(usage));
    // 1回のやりとりの速さ（ミリ秒）：話し終わり→文字、文字→返事を始める、AIが書きはじめるまで、最初の声まで、ぜんぶ。どの声で鳴ったか
    { const fromHeard = S.heardAt && tm.t0 - S.heardAt < 20000 ? tm.t0 - S.heardAt : null;
      console.log('turn', JSON.stringify({ owner: S.owner, name: S.me, avatar: S.avatar, app: S.app || '', model: use.model, eou: fromHeard == null ? null : S.eouMs, page: fromHeard, ai: tm.tok ? tm.tok - tm.t0 : null, voice1: tm.audio ? tm.audio - tm.t0 : null, total: Date.now() - tm.t0, sent: seq, chars: (text || '').length, voice: tv.voice || '', elErr: tv.elErr || '' })); }
    send({ type: 'reply_end', gen, emotion, text, why: text ? undefined : lastErr.slice(0, 120), usage });
    S.speaking = false; S.aborter = null;
    if (S.mode === 'family' && logText && !noRecord) gas(Object.assign({ action: 'log', said: logText, reply: text }, S.auth)).catch(() => {});
    if (convoKey() && text && !noRecord) {
      S.newTurns++;
      saveConvo(convoKey(), { turns: S.history.slice(-keepN()), newTurns: S.newTurns, at: Date.now() });
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
    if (m.type === 'ping') return send({ type: 'pong' });   // つながっているかの確かめ（画面が「聞いてる」のまま止まらないように）
    try {
      if (m.type === 'hello') {
        S.mode = m.mode === 'business' ? 'business' : 'family';
        S.voice = /^ja-JP-[\w-]+$/.test(m.voice || '') ? m.voice : '';
        S.auth = m.idToken ? { idToken: String(m.idToken) } : { pass: String(m.pass || '') };
        S.ref = String(m.ref || '').replace(/[^\w-]/g, '').slice(0, 20);
        S.agent = ['service', 'seminar-biz', 'seminar-partner'].includes(m.agent) ? m.agent : '';
        S.visit = String(m.visit || '').replace(/[^\w-]/g, '').slice(0, 20);   // ご縁の図から、その人のAI棒と話す   // 公式LINEのリッチメニューの「ハタボに相談」：サイトと同じサービス相談
        S.asGuest = !!m.asGuest;
        S.app = m.app === 'komugi' ? 'komugi' : m.app === 'hatabo' ? 'hatabo' : '';   // どのミニアプリから来たか（コムギのミニアプリなら、いつもコムギ）
        S.peek = !!m.peek;               // 見るだけ（&test=peek）：紹介のつながり・アバターの記録を変えない          // 家族が「窓口の画面」を試すとき（&test=guest）
        try { await loadBrain(); } catch (e) {
          if (e.code === 'auth' || e.code === 'pass') return fail('auth', String(e.message).slice(0, 80));
          if (e.code === 'closed') return fail('closed', 'いま窓口はお休み中');
          // GASが読めないときも切らずに話す（家族の記録なし）。三人モードなどはページから受けとる
          S.system = MIN_PERSONA + SELF; S.brainAt = Date.now() - 9 * 60 * 1000;
          send({ type: 'notice', why: 'brain', detail: 'GASが読めないので、記録なしで話しています' });
        }
        // ヒアリング役の人：紹介コード付きで来たら覚える。メニューやトークのボタン（コードなし）から来たら、覚えたコードで開きなおす
        if (S.guest && S.owner && !S.peek && !S.visit && !S.asGuest) {
          if (S.ref && isPinRole(S.role)) { await setPin(S.owner, S.ref); if (isHearingRole(S.role)) await hearingStart(S.ref, S.me); }
          else if (!S.ref || S.agent === 'service') {
            const pinned = await getPin(S.owner);
            if (pinned) {
              const was = { ref: S.ref, agent: S.agent };
              S.ref = pinned; S.agent = '';
              try { await loadBrain(); } catch (e) { S.ref = was.ref; S.agent = was.agent; await loadBrain().catch(() => {}); }
              if (!isPinRole(S.role)) { await setPin(S.owner, ''); S.ref = was.ref; S.agent = was.agent; await loadBrain().catch(() => {}); }   // もうヒアリング役でなければ、覚えたコードを消して元どおり
              else { console.log('ref pin', pinned); if (isHearingRole(S.role)) await hearingStart(pinned, S.me); }
            }
          }
        }
        // ハタボのミニアプリで家族（ヒロさん）が開いたとき：中身は家族のまま、声と話し方はハタボ
        if (S.app === 'komugi' && !S.guest) {
          S.avatar = 'komugi'; S.voice = AVS.komugi.voice();
          S.system += '\n\n【いまの話し方】ここはコムギのミニアプリ。あなたの名前はコムギ。' + KOMUGI_PERSONA;
        } else if (S.app === 'hatabo' && !S.guest) {
          S.avatar = 'hatabo'; S.voice = AVS.hatabo.voice();
          S.system += '\n\n【いまの話し方】ここはハタボのミニアプリ。あなたの名前はハタボ（愛称ハタボー）。一人称は「ぼく」。やわらかい丁寧語（です・ます）で話し、語尾に「〜ボー」はつけない。江戸っ子の話し方（てやんでぃ・がってん・〜だぜ）はしない。コムギ（馬越さんの相棒・一人称「うち」・博多弁）ではないので、コムギとして名のったり、博多弁（〜けん・〜とです）で話したりしない。';
        }
        S.ready = true;
        // 紹介コード：自分のコードを作り、はじめて来た人は「だれの紹介か」を覚える
        S.myRef = S.owner ? await myRefFor(S.owner) : '';
        if (S.myRef && !S.peek) {
          const mine = await getRef(S.myRef);
          let parent = mine && mine.parent ? mine.parent : (S.ref && S.ref !== S.myRef ? S.ref : '');
          let parentAt = mine && mine.parent ? (mine.parentAt || mine.at || Date.now()) : (parent ? Date.now() : 0), reRef = false;
          // 紹介の期限：前の紹介から90日たっても、お試しも契約もしていなければ、いま紹介してくれた人に切りかえる
          if (mine && mine.parent && S.ref && S.ref !== mine.parent && S.ref !== S.myRef && !mine.stage && Date.now() - parentAt > REF_DAYS * 86400000) { parent = S.ref; parentAt = Date.now(); reRef = true; console.log('ref renew', S.myRef, mine.parent, '->', parent); }
          S.refFrom = parent;
          await putRef(S.myRef, { owner: S.owner, name: S.me || (mine && mine.name) || '', parent, parentAt, at: (mine && mine.at) || Date.now() });
          // 初めて来た人（と、紹介が切りかわった人）なら、紹介した人の「ご縁」を1つふやす
          if ((!mine || reRef) && parent) { const up = await getRef(parent).catch(() => null); await putRef(parent, { kids: ((up && up.kids) || 0) + 1 }).catch(() => {}); }
          if (reRef) S.newVisit = true;
          if (!mine && parent) S.newVisit = true;
          S.funnel = funnelOf(mine);
          S.costYen = (mine && mine.costYen) || 0; S.costMon = (mine && mine.costMon) || ''; S.costMonYen = (mine && mine.costMonYen) || 0;
          { const d0 = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10), born = mine && mine.at ? new Date(mine.at + 9 * 3600000).toISOString().slice(0, 10) : d0; S.firstDay = born === d0; }   // はじめて来た日は、長めに話せる・回数も多め
          if (S.newVisit && parent) tellUpline(S, 'ハタボと話しはじめました', 'visit').catch(() => {});
          if (mine && mine.stage === 'trial' && S.funnel.stage === 'contract' && !mine.thanked) { putRef(S.myRef, { stage: 'contract', thanked: true, contractAt: mine.trialUntil || Date.now() }).catch(() => {}); tellUpline(S, (S.funnel.lineupName || '') + ' ' + (S.funnel.grade || '') + 'を契約しました', 'contract').catch(() => {}); }
          // 紹介から来た人は、紹介した人のアバターで（コムギの紹介ならコムギ）。リッチメニューのサービス相談と、役割を決めた窓口はそのまま
          if (S.guest && !S.agent && !S.visit && S.app !== 'komugi') {   // コムギのミニアプリは、ハタボのアバターの記録に引っぱられない
            if (S.role !== '汎用' && S.role !== 'サービス相談') {
              // 役割を決めたURL（馬越さんの ?ref=mac など）で開いた人：そのアバターを自分のものとして覚える
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
            const gotCard = async () => ((await loadCol(S.myRef, 'cards')).items || []).some(c => c.kind === 'user' && (c.id === S.visit || c.code === S.visit));   // ガチャで出たオーナーのAI棒とも話せる（連絡先は、オーナーが友だち申請を承認したときだけ）
            const t = sp ? null : S.visit !== S.myRef && (await canTalk(S.myRef, S.visit) || await gotCard()) ? await getRef(S.visit).catch(() => null) : null;
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
          // コムギ：馬越さん本人なら制限なしの相棒。馬越さんの紹介の人には、馬越さんへの橋渡し役に徹する
          if (S.avatar === 'komugi' && !S.visit) {
            if (isMac(S.owner) || isKomugiOwner(S.owner)) { S.macSelf = true; const nw = await komugiNews(); S.system += docsBlock(await docsLoad(S.owner).catch(() => ({})), false) + (isMac(S.owner) ? MAC_SELF_BLOCK : ownerSelfBlock(komugiOwnerName(S.owner) || String(S.me || 'ヒロ').replace(/さん$/, ''))) + '\n\n【いま入っているコムギ通信（紹介の人に案内する分）】\n' + (nw || '（まだ入っていない）'); }
            else { S.bridge = true; S.system += KOMUGI_BRIDGE + docsBlock(await docsLoad(macOwnerKey()).catch(() => ({})), true); if (!S.komugi) { S.komugi = true; S.system += komugiBlock(await komugiNews()); } }
          }
          // 紹介の手数料のため：馬越さん（コムギ）経由で来た人に、紹介者「mac」を一度だけしるす（あとで契約を数える）
          if (S.myRef && !S.peek && (S.app === 'komugi' || k || S.avatar === 'komugi')) {
            const me0 = await getRef(S.myRef).catch(() => null);
            if (me0 && !me0.introducer && !isMac(S.owner) && !isKomugiOwner(S.owner)) putRef(S.myRef, { introducer: 'mac', introducedAt: Date.now() }).catch(() => {});
            S.introducer = (me0 && me0.introducer) || (isMac(S.owner) || isKomugiOwner(S.owner) ? '' : 'mac');
          }
        }
        const pr = await loadPrefs(S.owner);
        // キャラ設定もハタボとコムギで分ける（コムギは「持ち主:komugi」）。馬越さんの前からの設定は、分けた場所がまだ空ならそのまま使う
        const pk = S.owner && charSfx() ? await loadPrefs(ownKey(S.owner)) : null;   // 持ち主×キャラ（ジュニアは持ち主のIDそのもの）
        const myCustom = pk ? pk.custom || (charOf() === 'hatabo' || isMac(S.owner) ? pr.custom : null) : pr.custom;   // 分ける前の設定は、ハタボ（と馬越さんのコムギ）だけ引きつぐ
        S.custom = myCustom ? cleanCustom(myCustom) : null;
        S.baseVoice = S.baseVoice || S.voice; applyVoice();
        // コムギ：親（馬越さん）のもとで教わったこと・キャラ設定の指示は、紹介先のコムギにも引きつぐ（親の指示に従って育つ）
        const macOwner = ENV.MAC_OWNERS.length ? 'g:' + String(ENV.MAC_OWNERS[0]).replace(/:\d{4}-\d{2}-\d{2}$/, '').replace(/^g:/, '') : '';
        const lp = S.macSelf ? pr : S.bridge && macOwner ? await loadPrefs(macOwner) : S.guest ? await loadPrefs(GUEST_COMMON) : pr;
        if (S.bridge && macOwner) { const mk = await loadPrefs(macOwner + ':komugi'); if (mk.custom) lp.custom = mk.custom; }   // 親（馬越さん）のコムギのキャラ設定
        if (S.bridge && lp.custom) { const pc = cleanCustom(lp.custom); if (pc.about || pc.rules) S.system += '\n\n【親（馬越さん）からの指示。いつもこれに従う。ただしハタラボの決まり・安全・正直さが先】' + (pc.about ? '\n馬越さんのこと（本人が書いた）：' + pc.about : '') + (pc.rules ? '\n指示：' + pc.rules : ''); }      // 窓口は、ヒロさんがテストで教えたことをみんなで使う
        // コムギの教わったことは「持ち主:komugi」に置く（ハタボと分ける）。馬越さんの前からの分は、まだ分けていなければそのまま使う
        let lq = lp;
        { const ko = S.avatar === 'komugi' ? (S.macSelf ? S.owner : S.bridge && macOwner ? macOwner : '') : '';
          if (ko) { const kp = await loadPrefs(ko + ':komugi'); lq = Array.isArray(kp.lessons) || Array.isArray(kp.learned) ? kp : isMac(ko) ? lp : {}; } }
        if (charOf() === 'hatabo' && !S.guest && pk && (Array.isArray(pk.lessons) || Array.isArray(pk.learned))) lq = pk;   // 自分のハタボ：ハタボで教わったことを使う（まだなければ前からの分）
        S.lessons = Array.isArray(lq.lessons) ? lq.lessons.slice(-30) : [];
        S.learned = Array.isArray(lq.learned) ? lq.learned.slice(-20) : [];
        S.trio = S.guest ? false : typeof m.trio === 'boolean' ? m.trio : !!pr.trio;
        if (typeof pr.waitMs === 'number') S.waitMs = pr.waitMs;
        if (convoKey() && !S.asGuest) {      // テスト（&test=guest）は毎回まっさらから（前のテストの話を混ぜない）
          const c = await loadMyConvo();
          if (c) {
            S.memo = String(c.summary || '');
            if (Date.now() - (c.at || 0) < holdH() * 3600000) S.history = noKomugi(cleanTurns(c.turns));
            S.newTurns = Number(c.newTurns || 0);
            if (S.newTurns >= 2) setTimeout(summarize, 3000);       // 前回まとめきれなかった分（強制で切ったときなど）
          }
        }
        await memLoad();   // AIDのメモ帳（目次だけ使う。中身は話題が出たら）
        { const day = new Date().toISOString().slice(0, 10); await countLoad([(S.owner || 'anon') + ':' + day, '__guests:' + day]); }   // 回数を、ハードから読みもどす
        // ヒロさんの家族のジュニアと、馬越さんのコムギは、いつもClaudeと同じ（スーパー上位・答えの長さの決まりなし）
        S.claude = !S.visit && ((ENV.CLAUDE_FAMILY && !S.guest && !S.asGuest) || !!superUntil(S.owner));   // 馬越さんの紹介の人のコムギは、橋渡し役（制限つき）
        if ((S.avatar === 'hatabo' || S.avatar === 'komugi' || S.app) && !/【聞き取りのくせ】/.test(S.system)) S.system += HEAR_RULE;
        // ハタボの伝え先：招待した人がいればその人、いなければ「ハタボの事務局」（運営の個人の名前は出さない）
        if (S.avatar === 'hatabo' && !S.visit) {
          let to = 'ハタボの事務局';
          if (hearing() || sanbo()) to = 'ヒロさん'; else try { let up = S.refFrom ? await getRef(S.refFrom) : null; if (up && up.kind === 'group') up = up.parent ? await getRef(up.parent) : null; if (up && up.owner && up.name) to = up.name + 'さん'; } catch (e) {}
          S.tellTo = to;
          S.system = S.system.replace(/ハタラボの担当（ヒロさん）|ハタラボのヒロさん/g, to).replace(/〈伝え先〉/g, to).replace(/ヒロさん/g, to);
        }
        send({ type: 'ready', plain: hearing(), me: S.me, mode: S.mode, voice: S.voice || ENV.TTS_VOICE, profile: S.owner ? await loadProfile(S.owner).catch(() => null) : null, trio: S.trio, waitMs: S.waitMs, guest: !!S.guest, service: S.role === 'サービス相談', myRef: S.myRef || '', visit: S.visit ? { code: S.visit, name: S.visitHost } : null, avatar: S.avatar || '', komugi: !!S.komugi, mac: !!S.macSelf, office: !!S.owner && ENV.OFFICE_OWNERS.some(id => S.owner === id || S.owner === 'g:' + id), bridge: !!S.bridge, superUntil: superUntil(S.owner), canPlan: !!(S.claude || superUntil(S.owner)), claude: !!S.claude, aiName: !S.visit && S.custom && S.custom.aiName || '' });
        if (S.visit) { const T = S.avatar === 'komugi' ? x => x.replace(/だボー/g, 'です').replace(/ボー/g, 'です') : S.avatar === 'hatabo' ? bizBo : bizBo; return speakOnly(T(S.visitSponsor ? S.visitHost + 'のAI棒だボー。なんでも聞いてほしいボー。' : S.visitHost + 'さんのAI棒だボー。話してくれたことは、' + S.visitHost + 'さんに伝言で届けるボー。'), 'excited'); }
        if (m.greet && S.guest && S.consult) return recapGreet().then(deliverInbox).catch(() => {});      // 相談メモがある人には、振り返りからはじめる
        const hi = m.greet ? (S.guest ? (S.history.length ? againFor() : (AVS[S.avatar] ? greetFor() : guestGreeting(S.me))) : greeting(S.me, S.mode, S.trio)) : '';
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
        S.planChosen = true;   // 期限つきの人（馬越さんなど）は窓口でも自分で選べる
        S.plan = PLANS[m.plan] ? String(m.plan) : 'std';
        return send({ type: 'plan', plan: S.plan, label: PLANS[S.plan].label });
      }
      if (m.type === 'save_media') {               // 写真・動画をおうちのドライブへ（家族だけ）
        if (S.guest || S.asGuest) return;
        const data = String(m.data || '').replace(/^data:[\w/+.-]+;base64,/, '');
        if (!data || data.length > 14 * 1024 * 1024) return send({ type: 'notice', why: 'media', detail: '大きすぎて保存できませんでした' });
        try {
          const g = await gas(Object.assign({ action: 'media', kind: m.kind === 'video' ? 'video' : 'photo', mime: String(m.mime || 'image/jpeg').slice(0, 40), data }, S.auth));
          if (g && g.ok && g.url) send({ type: 'links', links: [{ title: (m.kind === 'video' ? '動画' : '写真') + 'をドライブに保存しました', url: g.url }] });
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
        await memLoad();
        const c = await loadMyConvo();
        if (c) { S.memo = String(c.summary || ''); if (Date.now() - (c.at || 0) < holdH() * 3600000) S.history = noKomugi(cleanTurns(c.turns)); }
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
      if (m.type === 'google_link') { if (!S.owner || !ENV.GOOGLE_CLIENT_ID) return send({ type: 'google', ready: !!ENV.GOOGLE_CLIENT_ID, linked: false }); const n = crypto.randomBytes(16).toString('hex'); gNonce.set(n, { owner: S.owner, at: Date.now(), docs: !!m.docs }); if (gNonce.size > 500) gNonce.clear(); return send({ type: 'google_url', url: ENV.PUBLIC_URL + '/google/start?n=' + n }); }
      if (m.type === 'google_auto') { await saveCol(gDocKey(S.owner), 'google', { auto: !!m.on }); const g = await gGet(S.owner); return send({ type: 'google', ready: true, linked: !!g.refresh, email: g.email || '', auto: g.auto !== false }); }
      if (m.type === 'google_unlink') { const g = await gGet(S.owner); if (g.refresh) { try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(gDec(g.refresh)), { method: 'POST' }); } catch (e) {} } await saveCol(gDocKey(S.owner), 'google', { refresh: '', email: '', folder: '' }); return send({ type: 'google', ready: !!ENV.GOOGLE_CLIENT_ID, linked: false }); }
      if (m.type === 'note_drive') { const items = await loadNotes(S.owner), it = items.find(x => x.id === String(m.id || '')); if (it) { it.url = await driveSave(S.owner, it.title, it.text).catch(() => null) || it.url || ''; await saveNotes(S.owner, items); } return send(Object.assign(await myPage(S), { driveMsg: it && it.url ? 'Googleドライブに保存しました' : 'Googleドライブに保存できませんでした' })); }
      if (m.type === 'custom_get') return send({ type: 'custom', c: S.custom || cleanCustom({}), tones: TONES, lens: LENS, dialects: DIALECTS, voices: Object.fromEntries(Object.entries(VOICES).map(([k, v]) => [k, v.label])), presets: PRESETS, named: !!(S.custom && S.custom.aiName) });
      if (m.type === 'custom_set') {
        if (!S.owner || S.visit) return;
        const c = cleanCustom(m.c), old = S.custom || {};
        if (old.aiName && c.aiName !== old.aiName && !m.renameOk) c.aiName = old.aiName;   // 名前の変更はオプション（最初の名付けは無料）
        S.custom = c; await savePrefs(ownKey(S.owner), { custom: c }); applyVoice();
        return send({ type: 'custom', c, tones: TONES, lens: LENS, dialects: DIALECTS, voices: Object.fromEntries(Object.entries(VOICES).map(([k, v]) => [k, v.label])), presets: PRESETS, named: !!c.aiName, saved: true, aiName: c.aiName });
      }
      if (m.type === 'rename_req') { gas(Object.assign({ action: 'lead', lead: { who: S.me, ref: '', kind: '契約', title: 'AI棒の名前の変更（1,000円）：' + String(m.name || '').slice(0, 12), need: '名前の変更', when: '', budget: '1,000円', next: 'お支払いのあと名前を変える', memo: '' } }, S.auth)).catch(() => {}); return send({ type: 'notice', why: 'rename', detail: '名前の変更を申し込みました。お支払いの案内のあと変わります' }); }
      if (m.type === 'ticket') return onTicket(m);
      if (m.type === 'reqs' || m.type === 'req_adopt') return onReqs(m);
      if (m.type === 'docs' || m.type === 'docs_set' || m.type === 'docs_share' || m.type === 'docs_copy') return onDocs(m);
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

/* ===== GPT-Live-1 の検証（ハタリス）：話すのは GPT-Live-1、むずかしいこと・調べものは Claude が考えて渡す ===== */
const LIVE_RULE = '\n\n【声の係として】いまは声だけで話している。日本語で、短く、テンポよく。相手が話している途中でも、あいづちは短く。わからないこと、今の情報（天気・ニュース・値段・営業時間）、料金や契約のくわしいこと、考えるのに時間がかかることは、自分で答えずに、うしろにいる頭（仲間）に任せる。任せたら「ちょっと調べるボー」のように一言だけ言って待ち、もらった答えを自分の言葉で短く伝える。もらっていないことは言わない。';
const LIVE_BRAIN = '\n\n【いまのあなたの役目】あなたは、声で話しているハタボの「頭」。声の係から任された質問に、調べたり考えたりして答える。返すのは、声の係がそのまま話せる日本語の答え。2〜4文、200字以内。記号・URL・箇条書きは使わない。確かでないことは確かでないと言う。';
function liveInstructions() {
  return (HATABO_PERSONA + HATABO_SELF + (LINEUP_STYLE.ris || '') + SERVICE_KNOWLEDGE() + HATABO_LAST).replace(/〈伝え先〉|ハタラボの担当（ヒロさん）|ハタラボのヒロさん|ヒロさん/g, 'ハタボの事務局');
}
const liveDay = { day: '', n: 0 };
function liveCors(req, res) {
  const o = req.headers.origin || '';
  if (o && ENV.ALLOWED_ORIGINS.some(a => o === a || o.endsWith('.' + a.replace(/^https?:\/\//, '')))) {
    res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}
async function liveHttp(req, res) {
  liveCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const out = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
  if (req.method !== 'POST') return out(405, { error: 'post' });
  let body = '';
  for await (const c of req) { body += c; if (body.length > 200000) return out(413, { error: 'big' }); }
  let q; try { q = JSON.parse(body); } catch (e) { return out(400, { error: 'json' }); }
  if (!ENV.LIVE_KEY || String(q.k || '') !== ENV.LIVE_KEY) return out(403, { error: 'key' });
  if (!ENV.OPENAI_KEY) return out(503, { error: 'OPENAI_API_KEY がまだ入っていない' });
  if (!q.sdp) return out(400, { error: 'sdp' });
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  if (liveDay.day !== today) { liveDay.day = today; liveDay.n = 0; }
  if (liveDay.n >= ENV.LIVE_DAILY) return out(429, { error: 'きょうの回数がいっぱい' });
  liveDay.n++;
  const r = await fetch('https://api.openai.com/v1/live/sessions', { method: 'POST',
    headers: { Authorization: 'Bearer ' + ENV.OPENAI_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: { model: 'gpt-live-1', instructions: (liveInstructions() + LIVE_RULE).slice(0, 40000), audio: { output: { voice: String(q.voice || ENV.LIVE_VOICE) } }, delegation: { type: 'client' } }, transport: { type: 'webrtc', sdp: String(q.sdp) } }) }).catch(e => ({ ok: false, status: 0, text: async () => String(e.message) }));
  if (!r.ok) { const t = (await r.text()).slice(0, 300); console.error('live ng', r.status, t); return out(502, { error: 'openai ' + r.status, detail: t }); }
  const j = await r.json();
  const id = j.session && j.session.id;
  if (id) liveBrain(id, String(q.name || '').slice(0, 20));
  out(200, { sdp: j.transport && j.transport.sdp, id });
}
/** 横からつないで、聞こえた言葉を覚え、任されたら Claude に考えてもらう */
function liveBrain(id, name) {
  const WS = require('ws');
  const ws = new WS('wss://api.openai.com/v1/live/sessions/' + encodeURIComponent(id) + '/attach', { headers: { Authorization: 'Bearer ' + ENV.OPENAI_KEY } });
  const turns = [];   // {who:'人'|'ハタボ', text}
  const add = (who, t) => { if (!t) return; const last = turns[turns.length - 1]; if (last && last.who === who) last.text += t; else turns.push({ who, text: t }); if (turns.length > 30) turns.shift(); };
  const t0 = Date.now(); let nDel = 0, lastIn = 0;
  const stop = setTimeout(() => { try { ws.send(JSON.stringify({ type: 'session.close', event_id: 'end' })); } catch (e) {} setTimeout(() => { try { ws.close(); } catch (e) {} }, 3000); }, ENV.LIVE_MAX_MIN * 60000);
  ws.on('message', async raw => {
    let ev; try { ev = JSON.parse(String(raw)); } catch (e) { return; }
    if (ev.type === 'session.input_transcript.delta') { add('人', ev.delta || ev.text || ''); lastIn = Date.now(); return; }
    if (ev.type === 'session.output_transcript.delta') { add('ハタボ', ev.delta || ev.text || ''); return; }
    if (ev.type === 'session.closed') { console.log('live closed', JSON.stringify({ id, min: Math.round((Date.now() - t0) / 6000) / 10, delegations: nDel, usage: ev.usage || null })); return; }
    if (ev.type === 'error') { console.error('live error', JSON.stringify(ev).slice(0, 300)); return; }
    if (ev.type !== 'session.delegation.created' || !ev.delegation || !ev.delegation.id) return;
    const did = ev.delegation.id, at = Date.now(); nDel++;
    const talk = turns.slice(-14).map(x => x.who + '：' + x.text.trim()).join('\n');
    let answer = '';
    try {
      const params = { model: ENV.SMART_MODEL, max_tokens: 700, system: liveInstructions() + LIVE_BRAIN + nowLine(),
        messages: [{ role: 'user', content: (name ? '（話している人：' + name + 'さん）\n' : '') + 'ここまでの会話：\n' + talk + '\n\n声の係から任された、いちばん新しい「人」の問いに答えて。' }] };
      if (ENV.WEB_SEARCH) params.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2, user_location: { type: 'approximate', city: 'Tokyo', country: 'JP', timezone: 'Asia/Tokyo' } }];
      const m = await deps.claude.messages.create(params);
      answer = clean((m.content || []).filter(b => b.type === 'text').map(b => b.text).join('')).trim();
    } catch (e) { console.error('live brain ng', String(e.message).slice(0, 200)); }
    if (!answer) answer = 'ごめんなさい、いまは答えが見つかりませんでした。事務局に確認しておきます。';
    try { ws.send(JSON.stringify({ type: 'session.commentary.append', event_id: 'c' + nDel, delegation_id: did, content: answer.slice(0, 900) })); } catch (e) {}
    console.log('live delegate', JSON.stringify({ id, ms: Date.now() - at, sinceSpeech: lastIn ? at - lastIn : null }));
  });
  ws.on('error', e => console.error('live attach ng', String(e.message).slice(0, 200)));
  ws.on('close', () => clearTimeout(stop));
}

/* ===== HTTP と WebSocket ===== */
function createServer() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/google/')) return googleHttp(req, res);
    if (req.url.startsWith('/voice/try')) {   // 読み方の聞きくらべ：/voice/try?k=合言葉&text=ハタボが&voice=m-bright（声だけ。読み方辞書もかける）
      const u0 = new URL(req.url, 'http://x'), k = u0.searchParams.get('k') || '';
      if (!k || (k !== ENV.CRON_KEY && k !== ENV.LIVE_KEY)) { res.writeHead(403); return res.end('no'); }
      const v = VOICES[u0.searchParams.get('voice')] ? VOICES[u0.searchParams.get('voice')].name : ENV.HATABO_VOICE;
      return synth(String(u0.searchParams.get('text') || 'ハタボが').slice(0, 80), v, 'smile').then(b64 => { res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end(Buffer.from(b64, 'base64')); }).catch(e => { res.writeHead(500); res.end(String(e.message)); });
    }
    if (req.url.startsWith('/live/session')) return liveHttp(req, res).catch(e => { console.error('live', e); try { res.writeHead(500); res.end('{}'); } catch (x) {} });   // GPT-Live-1 の検証
    if (req.url.startsWith('/cron/faq')) { const u0 = new URL(req.url, 'http://x'), k = u0.searchParams.get('key'); if (!ENV.CRON_KEY || k !== ENV.CRON_KEY) { res.writeHead(403); return res.end('no'); } return faqDigest(Number(u0.searchParams.get('days')) || 7).then(o => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); }).catch(e => { res.writeHead(500); res.end(String(e.message)); }); }
    if (req.url.startsWith('/cron/digest')) { const k = new URL(req.url, 'http://x').searchParams.get('key'); if (!ENV.CRON_KEY || k !== ENV.CRON_KEY) { res.writeHead(403); return res.end('no'); } return sendDigests().then(async n => { const h = await hearingCheckAll().catch(() => 0); res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('sent ' + n + (h ? ' / hearing ' + h : '')); }).catch(e => { res.writeHead(500); res.end(String(e.message)); }); }
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
module.exports = { createServer, deps, ENV, splitter, takeEmotion, clean, PHOTO_RE, VIDEO_RE, session, calledJunior, calledJam, hearingStart, hearingCheckAll };
