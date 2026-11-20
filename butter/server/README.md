# バターちゃんジュニアのサーバー（Google Cloud Run）

LINEミニアプリのバターちゃんが、Claudeアプリのようになめらかに話すためのサーバーです。

- 声は流しっぱなしで聞く（Google 聞き取り）→ Claude が一文ずつ返事 → 一文ずつすぐ読み上げる
- 話している途中に声をかけると止まって聞く（割りこみ）
- 「写真撮って」「これ見て」で写真、「動画撮って」で10びょうの動画。言われたときだけ。写真は保存しない
- 三人モード：ヒロさん・Claudeアプリのバターちゃん・ジュニアの三人で話す。ジュニアは「ジュニア」と呼ばれたときだけ、まわりが静かになるのを待ってから短く答える。呼ばれていない声は話の流れとして覚えておく。「ジュニア、もっと間をあけて」「ジュニア、すぐ答えて」で待つ時間を覚える（持ち主ごと）
- 会話のつづき：家族モードでは、さいきんのやりとりを持ち主ごとに保存し、6回ごとと切れたときに「まとめ」を作る。次に開くと、まとめと続きから話す。まとめはGASの `note` で「ジュニア日記 …」としてドライブに残り、アプリのバターちゃんが読む。アプリのバターちゃんが書く「ジュニアへのことづて …」は、ジュニアが読む
- 話し方：声は低めでガラガラ（Chirp3-HD-Algenib）、やわらかい丁寧語（です・ます、一人称は「ぼく」。11/19に江戸っ子をやめてハタボと統一）、ふだんも1〜2文。名前を呼ばれただけなら、すぐ一言で返す
- 窓口：家族以外のLINEの人が開くと、自動で窓口のジュニアになる（家族の記録は読まない）。案件メモは毎回メール、日曜24時にLINEで週まとめ（GAS）。紹介コードでだれの紹介かがわかる。上限：1人1日30回（紹介コードなしは10回）、窓口ぜんぶで1日300回。止めるときはGASの `butterGuestOff`（紹介コードごとは `butterBlockRef`）
- IDの決まり（持ち主×キャラ）：キャラごとに変わるもの（会話の記録・まとめ・教わったこと・気づいたこと・キャラ設定）は、持ち主のIDとキャラの組み合わせで分ける。ジュニアは持ち主のIDのまま、ハタボは「持ち主:hatabo」、コムギは「持ち主:komugi」。人ごとのもの（メモ・議事録・ご縁のプロフィール・Google連携・回数・三人モード・待つ時間）は持ち主のIDのまま。ハタボは、分ける前の記録や設定があれば一度だけ引きつぐ（コムギの話はのぞく）
- 清掃ヒアリング：「窓口の紹介」シートで役割を「清掃ヒアリング」にした紹介URL（たくちゃんの ?ref=taku）は、ヒロさんの代わりに清掃管理の作り直しに必要なことを1問ずつ聞く。キャラは出さずトーク画面だけ、売りこみはしない。聞けたことは、まとめて事務局（OFFICE_OWNERS）のLINEにすぐ届く（ハタボの公式LINEのトークン HATABO_LINE_TOKEN が要る。なければ1日1回のまとめに入る）
- ご縁つなぎ：相棒どうしが話して、持ち主どうしの相性をさがす。相手に伝わるのは「紹介してよいこと」だけ
- 人格・家族OSの記録・おうち日記は GAS（butter.gs の `brain` / `log`）から。本人確認も GAS（LINEのIDトークン、または合言葉）
- 交流会（ビジネス）モードは、家族の記録を読まず、おうち日記にも書かない

秘密はこのリポジトリに入れません。Claude のキーは Secret Manager、GAS の URL は Cloud Run の環境変数に入れます。

## 動作確認

```
npm install
npm test
```

## 置き方（Cloud Shell で、上から順に貼る）

1. Google Cloud で、プロジェクト butter-voice を選び、右上の「Cloud Shell をアクティブにする」を押す。
2. 下のコマンドを貼る。キーとGASのURLは、聞かれたときに入力する（画面にもチャットにも残らない）。

```
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com firestore.googleapis.com speech.googleapis.com texttospeech.googleapis.com
gcloud firestore databases create --location=asia-northeast1 || true
read -s -p "Claudeの新しいキー: " K; echo; printf '%s' "$K" | gcloud secrets create anthropic-key --data-file=- ; unset K
PN=$(gcloud projects describe $(gcloud config get-value project) --format='value(projectNumber)')
SA=$PN-compute@developer.gserviceaccount.com
gcloud secrets add-iam-policy-binding anthropic-key --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
gcloud projects add-iam-policy-binding $(gcloud config get-value project) --member=serviceAccount:$SA --role=roles/datastore.user
rm -rf terakoya && git clone --depth 1 https://github.com/hiromitsu81/terakoya
read -p "GASのURL（…/exec）: " G
gcloud run deploy butter-junior --source terakoya/butter/server --region asia-northeast1 --allow-unauthenticated \
  --set-secrets ANTHROPIC_API_KEY=anthropic-key:latest --set-env-vars GAS_URL=$G \
  --timeout 3600 --session-affinity --max-instances 3 --concurrency 20 --memory 512Mi
```

3. 最後に出る `Service URL: https://butter-junior-….run.app` のホスト名を、index.html の `JR_DEFAULT` に入れる（またはミニアプリのURLに `&s=ホスト名` を足す）。

## 返事を速くする（任意）

いまの場所（REGION）は `gcloud run services list` でわかる。asia-northeast1 なら東京なので、そのままでよい。

サーバーを1台起こしたままにすると、最初の返事が速くなる。そのぶん少しお金がかかる（目安で月1,000〜2,000円ほど）。やめるときは `--min-instances 0`。

```
gcloud run services update butter-junior --region asia-northeast1 --min-instances 1
```

## GPT-Live-1 の検証（ハタリス）

話すのは GPT-Live-1、むずかしい質問・調べものは Claude（SMART_MODEL）が考えて渡す。検証ページは `butter/live.html`（GitHub Pages）。

1. Cloud Shell で、OpenAI のキーと検証ページの合言葉を入れる（画面にもチャットにも残らない）。

```
read -s -p "OpenAIのキー: " K; echo; printf '%s' "$K" | gcloud secrets create openai-key --data-file=- ; unset K
PN=$(gcloud projects describe $(gcloud config get-value project) --format='value(projectNumber)')
gcloud secrets add-iam-policy-binding openai-key --member=serviceAccount:$PN-compute@developer.gserviceaccount.com --role=roles/secretmanager.secretAccessor
read -s -p "検証ページの合言葉: " L; echo
gcloud run services update butter-junior --region asia-northeast1 --update-secrets OPENAI_API_KEY=openai-key:latest --update-env-vars LIVE_KEY=$L ; unset L
```

2. スマホで `https://hiromitsu81.github.io/terakoya/butter/live.html` を開き、合言葉を入れて「話しはじめる」。
3. 見ること：日本語の自然さ、あいづちと割りこみ、聞きまちがい、むずかしい質問への答え（ログの `live delegate` に Claude の待ち時間）、1回の費用（`live closed`）。

| 名前 | ふだん |
|---|---|
| LIVE_VOICE | marin（GPT-Live-1 の声） |
| LIVE_DAILY | 40（1日に始められる回数、ぜんぶで） |
| LIVE_MAX_MIN | 15（1回の上限、分） |

費用の目安：声が1分約0.05ドル（約7.5円）＋Claude の分。

## 直したあと

```
cd terakoya && git pull && cd ..
gcloud run deploy butter-junior --source terakoya/butter/server --region asia-northeast1
```

## 設定（環境変数、なくてもよい）

| 名前 | ふだん |
|---|---|
| MODEL | claude-haiku-4-5-20251001 |
| SMART_MODEL | claude-sonnet-5-5（調べもの・勉強） |
| PREMIUM_MODEL | claude-opus-5-5（家族の画面のプランおためし：上位・スーパー上位） |
| TTS_VOICE | ja-JP-Chirp3-HD-Leda |
| TTS_RATE | 1.08 |
| DAILY_LIMIT | 400（一人1日に答える回数） |
| SESSION_MAX_MIN | 60（1回つなぎっぱなしにできる分） |
| EOU_MS | 800（話し終わりの見分け。文字がこのミリ秒かわらなければ返事を始める。切られやすいときは1000、0でGoogleまかせ） |
| ELEVENLABS_FORMAT | mp3_44100_128（ElevenLabsの声の音質） |
| ALLOWED_ORIGINS | https://hiromitsu81.github.io ほか |

## ウェブのログインと、ハタボAPI（MCP）

- サイトの「ログイン」（hatabo-site/login.html）
  - **LINEでログイン**：PCでは app.hatha-lab.com をブラウザで開いて、LINEでログインします。スマホではミニアプリが開きます（`page=login`）。事務局は管理画面へ、オーナーはMyハタボへ、自動で分かれます。
  - **Googleでログイン**：`/google/login` → 既存の `/google/callback`（新しいリダイレクトURIの登録は不要）。12時間の印（`#wt=`）をつけて app.hatha-lab.com へ戻ります。
    - オーナー：Myハタボの「設定」→「Googleアカウント連携」でつないだGoogleなら、そのMyハタボへ。※この機能を入れる前につないだ人は、一度つなぎ直すと使えます。
    - 事務局：`OFFICE_EMAILS` にあるメール、または OFFICE_OWNERS の人がつないだGoogle。
- ハタボAPI（MCP）：`POST {PUBLIC_URL}/mcp/<APIキー>`（または `Authorization: Bearer <APIキー>`）
  - 道具：search_aibo・send_message・request_reservation・list_my_aibo・update_my_aibo・get_usage
  - キーはMyハタボの「もっと」→「AIからつなぐ（API）」で作る（5つまで・作ったときだけ表示）。
  - 検索に出るのは、オーナーが「AIからの検索に出す」をオンにした役割つきの愛棒だけ。LINEのIDは出さない。
  - 料金は記録して見こみを出すところまで（請求はまだ）。1分60回・伝言は1日100回までに制限。

Cloud Run に入れる環境変数（チャットに貼らず、Cloud Shell で直接）：
- `WEB_SECRET`：ウェブのログインの印の鍵（長いランダムな文字。なければ GOOGLE_CLIENT_SECRET から作る）
- `OFFICE_EMAILS`：Googleで管理画面に入れる事務局のメール（カンマ区切り）
- `API_PRICE`（任意）：`{"free":100,"search":1,"message":5,"reserve":5,"done":30}`
