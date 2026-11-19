# バターちゃんジュニアのサーバー（Google Cloud Run）

LINEミニアプリのバターちゃんが、Claudeアプリのようになめらかに話すためのサーバーです。

- 声は流しっぱなしで聞く（Google 聞き取り）→ Claude が一文ずつ返事 → 一文ずつすぐ読み上げる
- 話している途中に声をかけると止まって聞く（割りこみ）
- 「写真撮って」「これ見て」で写真、「動画撮って」で10びょうの動画。言われたときだけ。写真は保存しない
- 三人モード：ヒロさん・Claudeアプリのバターちゃん・ジュニアの三人で話す。ジュニアは「ジュニア」と呼ばれたときだけ、まわりが静かになるのを待ってから短く答える。呼ばれていない声は話の流れとして覚えておく。「ジュニア、もっと間をあけて」「ジュニア、すぐ答えて」で待つ時間を覚える（持ち主ごと）
- 会話のつづき：家族モードでは、さいきんのやりとりを持ち主ごとに保存し、6回ごとと切れたときに「まとめ」を作る。次に開くと、まとめと続きから話す。まとめはGASの `note` で「ジュニア日記 …」としてドライブに残り、アプリのバターちゃんが読む。アプリのバターちゃんが書く「ジュニアへのことづて …」は、ジュニアが読む
- 話し方：声は低めでガラガラ（Chirp3-HD-Algenib）、江戸っ子っぽく、ふだんも1〜2文。名前を呼ばれただけなら、すぐ一言で返す
- 窓口：家族以外のLINEの人が開くと、自動で窓口のジュニアになる（家族の記録は読まない）。案件メモは毎回メール、日曜24時にLINEで週まとめ（GAS）。紹介コードでだれの紹介かがわかる。上限：1人1日30回（紹介コードなしは10回）、窓口ぜんぶで1日300回。止めるときはGASの `butterGuestOff`（紹介コードごとは `butterBlockRef`）
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
