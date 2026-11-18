# ハタボ公式LINE：リッチメニューとカードタイプ

- ベーシックID：@024curid（友だち追加：https://line.me/R/ti/p/@024curid ）
- プロバイダ：HATHA LAB（ミニアプリと同じ）
- Messaging APIのチャネルID：2012677968

マイハタボの画面（サイトの「マイハタボの画面」）と同じ並びにしています。色は白と紺、エンブレムは銀です。

## リッチメニュー（richmenu.jpg 2500×1686 ／ richmenu.json）
| 場所 | 名前 | 開く先 |
|---|---|---|
| 左（大） | ハタボに相談 | ミニアプリ本番 |
| 右上1 | マイハタボ | ?page=my |
| 右上2 | 育てたハタボ | ?page=grow |
| 右上3 | プラン・支払い | ?page=plan |
| 右下1 | AISAI・愛祭 | ?page=aisai |
| 右下2 | 紹介する | ?page=share |
| 右下3 | ハタボタイムズ | ?page=times |

左が大きい「1＋6」の形は、LINE Official Account Managerのテンプレートにないので、Messaging APIで登録します（下のGAS）。

## カードタイプ（cards_flex.json）
マイハタボ／お試し中／うちのハタボ（Lv・フォロワー・ご縁）／AISAI・愛祭／ハタボを紹介 の5枚のカルーセル。
`{{残り}}` などは、送るときにその人の数字に置きかえます。見た目は cards_preview.png。

## 登録（GAS・HATHA LABのチャネル）
スクリプトプロパティ `HATABO_LINE_TOKEN` に、ハタボ公式LINE（Messaging API）のチャネルアクセストークンを入れてから実行。

```js
function hataboRichMenu() {
  const T = PropertiesService.getScriptProperties().getProperty('HATABO_LINE_TOKEN');
  const B = 'https://hiromitsu81.github.io/terakoya/butter/line/';
  const H = { Authorization: 'Bearer ' + T };
  const def = UrlFetchApp.fetch(B + 'richmenu.json').getContentText();
  const id = JSON.parse(UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu', { method: 'post', contentType: 'application/json', headers: H, payload: def }).getContentText()).richMenuId;
  UrlFetchApp.fetch('https://api-data.line.me/v2/bot/richmenu/' + id + '/content', { method: 'post', contentType: 'image/jpeg', headers: H, payload: UrlFetchApp.fetch(B + 'richmenu.jpg').getBlob().getBytes() });
  UrlFetchApp.fetch('https://api.line.me/v2/bot/user/all/richmenu/' + id, { method: 'post', headers: H });
  console.log('リッチメニューを登録しました：' + id);
}
```

## まだのこと
- ミニアプリの `?page=` ごとの画面（マイハタボ・育てたハタボ・プラン…）はこれから。いまはどれもハタボとの会話が開きます。
