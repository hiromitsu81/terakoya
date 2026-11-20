#!/usr/bin/env bash
# Stripe（テスト）に、ハタボの全プランの値段を登録する。
# キーは Cloud Run（butter-junior）に入っている STRIPE_SECRET_KEY を読む。画面には出さない。
# lookup key は「ラインナップ_グレード_m／y」。年払いは月の10倍。「担当がご案内」は作らない。何度流しても同じものは作らない。
set -euo pipefail
K=$(gcloud run services describe butter-junior --region asia-northeast1 --format=json | python3 -c 'import json,sys;d=json.load(sys.stdin);print(next((e.get("value","") for c in d["spec"]["template"]["spec"]["containers"] for e in c.get("env",[]) if e["name"]=="STRIPE_SECRET_KEY"),""))')
[ -n "$K" ] || { echo "STRIPE_SECRET_KEY が読めません（シークレット参照のときは、ヒロさんに相談）"; exit 1; }
case "$K" in sk_test_*|rk_test_*) ;; *) echo "テストのキーではないので止めます"; exit 1;; esac
api() { curl -sS -u "$K:" "$@"; }
# ラインナップ グレード 名前 誰向け 月の値段
while read -r L G NAME WHO YEN; do
  for P in m y; do
    KEY="${L}_${G}_${P}"
    HIT=$(api -G https://api.stripe.com/v1/prices --data-urlencode "lookup_keys[]=$KEY" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len(d.get("data",[])))')
    if [ "$HIT" != "0" ]; then echo "あり  $KEY"; continue; fi
    PROD=$(api -G https://api.stripe.com/v1/products/search --data-urlencode "query=metadata['hb']:'${L}_${G}'" | python3 -c 'import json,sys;d=json.load(sys.stdin).get("data",[]);print(d[0]["id"] if d else "")')
    if [ -z "$PROD" ]; then
      PROD=$(api https://api.stripe.com/v1/products --data-urlencode "name=${NAME} ${G}（${WHO}）" -d "metadata[hb]=${L}_${G}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
    fi
    AMT=$YEN; IV=month; [ "$P" = y ] && { AMT=$((YEN*10)); IV=year; }
    OUT=$(api https://api.stripe.com/v1/prices -d product="$PROD" -d currency=jpy -d unit_amount="$AMT" -d "recurring[interval]=$IV" -d lookup_key="$KEY" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("id") or d.get("error",{}).get("message",""))')
    echo "作成  $KEY  ${AMT}円/${IV}  $OUT"
  done
done <<'LIST'
ietna X ハタイエンタ 家族の愛棒 5980
ietna G ハタイエンタ 家族の愛棒 12800
ris X ハタリス ひとりの愛棒 2980
ris G ハタリス ひとりの愛棒 4980
ris Z ハタリス ひとりの愛棒 12800
box X ハタボックス 個人事業の愛棒 5000
ace X ハタエース お店・宿の愛棒 10000
bora X ハタボーラ 会社の愛棒・1席 2980
bora G ハタボーラ 会社の愛棒・1席 9800
LIST
echo "おわり"
