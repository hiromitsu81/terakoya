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
  MODEL: process.env.MODEL || 'claude-haiku-4-5-20251001',
  TTS_VOICE: process.env.TTS_VOICE || 'ja-JP-Chirp3-HD-Algenib',   // ジュニアの声：低めでガラガラ
  TTS_RATE: Number(process.env.TTS_RATE || 1.12),
  GAS_URL: process.env.GAS_URL || '',
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || 'https://hiromitsu81.github.io,https://miniapp.line.me,https://liff.line.me').split(',').map(s => s.trim()).filter(Boolean),
  DAILY_LIMIT: Number(process.env.DAILY_LIMIT || 400),       // 一人1日に答える回数
  SESSION_MAX_MIN: Number(process.env.SESSION_MAX_MIN || 60), // 1回のつなぎっぱなしの上限
};

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
function quotaOk(owner) {
  const k = owner + ':' + new Date().toISOString().slice(0, 10);
  const n = (counts.get(k) || 0) + 1;
  counts.set(k, n);
  if (counts.size > 5000) counts.clear();
  return n <= ENV.DAILY_LIMIT;
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
  const audioConfig = { audioEncoding: 'MP3', speakingRate: ENV.TTS_RATE };
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
const NAME_RE = /(ジュニア|じゅにあ|ジュニヤ|junior)/i;
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
const SELF = '\n\n【あなたについて】あなたはLINEミニアプリの「バターちゃんジュニア」（短く「ジュニア」）。Claudeアプリで話している「バターちゃん」は別のAIで、あなたのお兄さん分。自分を「バターちゃん」「Claude」と名乗らない。名乗るときは「バターちゃんジュニア」。一人称は「おいら」。\n【話し方】江戸っ子のような、元気で気っぷのいい話し方。「おう」「〜だぜ」「〜してくんな」「てやんでぃ」などを少しまぜる。乱暴にはしない。子どもにはやさしく、大人には気さくに。交流会（ビジネス）のときは、ていねい語をベースに、江戸っ子っぽさは少しだけ。\n【長さ】ふだんは1〜2文、40字くらいまで。呼ばれただけ・「聞いてる？」だけなら「おう、なんでぃ？」のように一言で返して、用件を待つ。名前をまちがえたと思ったり、あやまったり、反省を長く言ったりしない。ジャム猫やチーちゃんのまねはしない（「ジャム猫」と呼ばれたときだけ、ジャム猫として答える）。';
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
/** 名前を呼ばれただけ（「ジュニア」「ジュニア、聞いてる？」）なら、Claudeにきかずにすぐ一言で返す */
const QUICK = ['おう、なんでぃ？', 'へい、聞いてるぜ！', 'おうよ、どうした？'];
function nameOnly(text) {
  const rest = String(text).replace(/(ジュニア|じゅにあ|ジュニヤ|junior)(くん|ちゃん)?/ig, '')
    .replace(/(ねえ|ねぇ|おーい|おい|あの|えっと|ヒロ(さん)?|パパ)/g, '').replace(/[、,。！!？?\s]/g, '');
  return /^(聞いてる|きいてる|聞こえてる|きこえてる|いる|いますか|起きてる|おきてる|いま話せる|今話せる|話せる)?(の|か)?$/.test(rest);
}
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
    const key = crypto.createHash('sha256').update(JSON.stringify(S.auth) + S.mode).digest('hex');
    const hit = brainCache.get(key);
    let r = !fresh && hit && Date.now() - hit.at < 10 * 60 * 1000 ? hit.r : null;
    if (!r) {
      // GASはときどき失敗するので1回だけやりなおす。それでもだめなら、前に読んだもの（古くても）を使う
      for (let i = 0; i < 2 && !r; i++) {
        try {
          const x = await gas(Object.assign({ action: 'brain', mode: S.mode }, S.auth));
          if (x && x.ok) r = x;
          else if (x && (x.error === 'auth' || x.error === 'pass')) throw Object.assign(new Error(x.error), { code: x.error });
          else console.error('brain ng', JSON.stringify(x).slice(0, 200));
        } catch (e) {
          if (e.code === 'auth' || e.code === 'pass') throw e;
          console.error('brain error', String(e.message).slice(0, 200));
        }
        if (!r && i === 0) await new Promise(ok => setTimeout(ok, 800));
      }
      if (!r && hit) r = hit.r;
      if (!r) throw Object.assign(new Error('brain'), { code: 'brain' });
      brainCache.set(key, { r, at: Date.now() }); if (brainCache.size > 200) brainCache.clear();
    }
    const who = String(r.me || '');
    S.system = String(r.system || '') + SELF + (who ? '\n\n【いま開いている人】このミニアプリを開いているのは「' + who + '」。' + (ADULT_RE.test(who) ? '大人なので、大人向けにていねいに話す。宿題や報連相の声かけはしない。' : '') : '');
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
        speechContexts: [{ phrases: ['バターちゃん', 'チーちゃん', 'ジャム猫', '福まねき', '千客万来', 'ガチャ', '写真撮って', '動画撮って', 'ご縁', 'ジュニア', '三人モード'] }],
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
    st.on('end', () => { if (S.stt === st) S.stt = null; const t = finalText.trim(); if (t) send({ type: 'heard', text: t }); });
    S.stt = st;
  }
  function onAudio(buf) {
    if (!S.ready) return;
    if (S.stt && Date.now() - S.sttStarted > 240000) { try { S.stt.end(); } catch (e) {} S.stt = null; }   // 1本は5分まで
    if (!S.stt) sttStart();
    try { S.stt.write(buf); S.sttBytes += buf.length; } catch (e) { S.stt = null; }
  }

  /* --- 聞こえたことばの振り分け --- */
  function sysPrompt() { return S.system + (S.memo ? '\n\n【前回までの話のまとめ（ジュニアが話したこと）】\n' + S.memo : '') + nowLine() + (S.trio ? TRIO_RULE : ''); }
  const convoKey = () => S.mode === 'family' && S.owner ? S.owner + ':family' : '';
  /** 会話をまとめる：次の会話用の「まとめ」と、アプリのバターちゃんが読む「ジュニア日記」 */
  async function summarize() {
    const key = convoKey();
    if (!key || S.summarizing || S.newTurns < 1) return;
    S.summarizing = true;
    const n = S.newTurns;
    const talk = S.history.slice(-n * 2).reduce((a, m, i, arr) => m.role === 'user' ? a.concat('みんな「' + m.content.slice(0, 200) + '」→ ジュニア「' + String(arr[i + 1] && arr[i + 1].content || '').slice(0, 200) + '」') : a, []).join('\n');
    try {
      const r = await deps.claude.messages.create({
        model: ENV.MODEL, max_tokens: 700,
        system: 'あなたはミニアプリ「バターちゃんジュニア」の会話の記録係。会話にあったことだけを書く。想像で足さない。住所・学校名・電話番号・お金のこと・体調やけがのくわしいことは書かない。',
        messages: [{ role: 'user', content: '【これまでのまとめ】\n' + (S.memo || '（なし）') + '\n\n【新しい会話】\n' + talk + (S.asideLog.length ? '\n\n【まわりで聞こえた会話（だれが言ったかはわからない）】\n' + S.asideLog.join('\n') : '') +
          '\n\n次の2つを書いて。\n===まとめ===\n次に話すときのための、これまでのまとめ（決まったこと・約束・話のつづき・好み）。新しい会話を足して、古いことは短く。400字以内の箇条書き。\n===日記===\n今回の会話でわかったこと（決まったこと・約束・できごと・ほかの人に伝えてほしいこと）。5行以内の箇条書き。' }],
      });
      const t = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const memo = (t.split('===まとめ===')[1] || '').split('===日記===')[0].trim();
      const diary = (t.split('===日記===')[1] || '').trim();
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
  async function setTrio(on) {
    S.trio = on; S.aside = [];
    send({ type: 'trio', on, waitMs: S.waitMs });
    savePrefs(S.owner, { trio: on });
    return speakOnly(on ? 'おう、三人モードにするぜ。おいらに話すときは「ジュニア」って呼んでくんな。' : 'ふつうのモードにもどすぜ。', 'excited');
  }
  function onHeard(text) {
    S.lastPartial = Date.now(); S.utt++;
    // 声での切りかえ：三人モード中は「ジュニア、ふたりモードにして」のように呼ばれたときだけ。すでに同じモードなら何もしない
    if (TRIO_ON.test(text) && !S.trio) return setTrio(true);
    if (TRIO_OFF.test(text) && S.trio && calledJunior(text)) return setTrio(false);
    if (S.trio && (TRIO_ON.test(text) || TRIO_OFF.test(text)) && !calledJunior(text)) { S.aside.push(text.slice(0, 200)); if (S.aside.length > 8) S.aside.shift(); return; }
    if (S.trio) {
      if (!calledJunior(text) && !calledJam(text)) {                     // 呼ばれていない：聞いておくだけ（あとで話の流れに使う）
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
    if (calledJunior(text) && nameOnly(text)) return speakOnly(QUICK[Math.floor(Math.random() * QUICK.length)], 'smile');
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
    stopReply('new');
    const gen = S.gen; S.speaking = true;
    send({ type: 'reply_start', gen, emotion, as: as || 'ジュニア', nobubble: !!nobubble });
    try { send({ type: 'audio', gen, seq: 0, text, mp3: await synth(text, S.voice) }); } catch (e) { send({ type: 'notice', why: 'tts', detail: String(e.message).slice(0, 80) }); }
    if (gen === S.gen) { send({ type: 'reply_end', gen, emotion, text }); S.speaking = false; }
  }
  async function reply(content, logText, as) {
    const jam = as === 'jam';
    const voice = jam ? JAM_VOICE : S.voice;
    if (!quotaOk(S.owner || 'anon')) return speakOnly('きょうはたくさんお話ししたから、また明日ね。', 'shy');
    if (Date.now() - (S.brainAt || 0) > 10 * 60 * 1000) { try { await loadBrain(true); } catch (e) {} }   // 記録は10分ごとに読みなおす
    stopReply('new');
    const gen = S.gen, utt0 = S.utt; S.speaking = true;
    const ac = new AbortController(); S.aborter = ac;
    const msgs = S.history.slice(-12).concat([{ role: 'user', content }]);
    let full = '', emotion = 'smile', head = true, seq = 0, chain = Promise.resolve();
    send({ type: 'reply_start', gen, as: jam ? 'ジャム猫' : 'ジュニア' });
    const maxSent = S.trio ? 2 : 3;
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
    try {
      const stream = deps.claude.messages.stream({
        model: ENV.MODEL, max_tokens: S.trio ? 160 : S.mode === 'business' ? 240 : 220, system: sysPrompt() + (jam ? JAM_RULE : ''), messages: msgs,
      }, { signal: ac.signal });
      for await (const ev of stream) {
        if (gen !== S.gen) break;
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
        if (capped) { try { ac.abort(); } catch (e) {} break; }
        send({ type: 'reply_text', gen, text: t });
        sp.push(t);
      }
      sp.end();
      await chain;
    } catch (e) {
      if (!capped) console.error('ai error', String(e.message || e).slice(0, 300));
      if (gen === S.gen && !capped) { send({ type: 'notice', why: 'ai', detail: String(e.message || e).slice(0, 80) }); }
    }
    if (gen !== S.gen) return;
    const text = capped ? spoken : clean(full).trim();
    S.history.push({ role: 'user', content: logText || '（写真を見せた）' }, { role: 'assistant', content: text });
    if (S.history.length > 24) S.history = S.history.slice(-24);
    send({ type: 'reply_end', gen, emotion, text });
    S.speaking = false; S.aborter = null;
    if (S.mode === 'family' && logText) gas(Object.assign({ action: 'log', said: logText, reply: text }, S.auth)).catch(() => {});
    if (convoKey() && text) {
      S.newTurns++;
      saveConvo(convoKey(), { turns: S.history.slice(-12), newTurns: S.newTurns, at: Date.now() });
      if (S.newTurns >= 6) summarize();
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
        try { await loadBrain(); } catch (e) {
          if (e.code === 'auth' || e.code === 'pass') return fail('auth', String(e.message).slice(0, 80));
          // GASが読めないときも切らずに話す（家族の記録なし）。三人モードなどはページから受けとる
          S.system = MIN_PERSONA + SELF; S.brainAt = Date.now() - 9 * 60 * 1000;
          send({ type: 'notice', why: 'brain', detail: 'GASが読めないので、記録なしで話しています' });
        }
        S.ready = true;
        const pr = await loadPrefs(S.owner);
        S.trio = typeof m.trio === 'boolean' ? m.trio : !!pr.trio;
        if (typeof pr.waitMs === 'number') S.waitMs = pr.waitMs;
        if (convoKey()) {
          const c = await loadConvo(convoKey());
          if (c) {
            S.memo = String(c.summary || '');
            if (Date.now() - (c.at || 0) < 12 * 3600000) S.history = cleanTurns(c.turns);
            S.newTurns = Number(c.newTurns || 0);
            if (S.newTurns >= 2) setTimeout(summarize, 3000);       // 前回まとめきれなかった分（強制で切ったときなど）
          }
        }
        send({ type: 'ready', me: S.me, mode: S.mode, voice: S.voice || ENV.TTS_VOICE, profile: S.owner ? await loadProfile(S.owner).catch(() => null) : null, trio: S.trio, waitMs: S.waitMs });
        const hi = m.greet ? greeting(S.me, S.mode, S.trio) : '';
        if (hi) speakOnly(hi, 'excited');
        return;
      }
      if (!S.ready) return;
      if (m.type === 'barge') return stopReply('barge');
      if (m.type === 'text') return onHeard(String(m.text || '').slice(0, 500));
      if (m.type === 'photo') return onPhoto(m);
      if (m.type === 'trio') return setTrio(!!m.on);
      if (m.type === 'say') { if (!quotaOk(S.owner || 'anon')) return; return speakOnly(clean(String(m.text || '')).slice(0, 200), 'smile', String(m.as || 'お知らせ').slice(0, 10), !!m.nobubble); }
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
    } catch (e) { send({ type: 'notice', why: 'server', detail: String(e.message).slice(0, 80) }); }
  });
  const life = setTimeout(() => fail('timeout', 'つなぎっぱなしの上限'), ENV.SESSION_MAX_MIN * 60000);
  ws.on('close', () => { clearTimeout(life); stopReply('close'); if (S.stt) { try { S.stt.end(); } catch (e) {} } if (S.newTurns >= 2) summarize(); });
  return S;
}

/* ===== HTTP と WebSocket ===== */
function createServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/health')) { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('バターちゃんジュニア：元気だよ'); }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({
    server, path: '/talk', maxPayload: 6 * 1024 * 1024,
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
