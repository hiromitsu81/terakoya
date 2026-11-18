/**
 * コムギの公式LINE（@858uraou）のリッチメニュー。butter.gs のいちばん下に貼って使う。
 *   1. komugiSetToken の 'ここにトークンを貼る' を、コムギの Messaging API のチャネルアクセストークンにして1回実行 → すぐ元に戻して保存
 *   2. komugiRichMenu を1回実行（紹介の人用＝ふだんのメニュー、マー君用＝「komugi-mac」）
 *   マー君用のメニューは、マー君がコムギを友だち追加したとき、サーバーが自動でつなぐ（Cloud Run の MAC_OWNERS にマー君のIDがあれば）
 */
function komugiSetToken() {
  const T = 'ここにトークンを貼る';
  if (T === 'ここにトークンを貼る') throw new Error('トークンを貼ってから実行してください');
  PropertiesService.getScriptProperties().setProperty('KOMUGI_LINE_TOKEN', T);
  console.log('入れました（' + T.length + '文字）。このあと、この関数のトークンを消してください');
}

function komugiRichMenu() {
  const T = PropertiesService.getScriptProperties().getProperty('KOMUGI_LINE_TOKEN');
  if (!T) throw new Error('先に komugiSetToken を実行してください');
  const B = 'https://hiromitsu81.github.io/terakoya/butter/line/komugi/';
  const H = { Authorization: 'Bearer ' + T };
  const make = name => {
    const def = UrlFetchApp.fetch(B + name + '.json').getContentText();
    const id = JSON.parse(UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu', { method: 'post', contentType: 'application/json', headers: H, payload: def }).getContentText()).richMenuId;
    UrlFetchApp.fetch('https://api-data.line.me/v2/bot/richmenu/' + id + '/content', { method: 'post', contentType: 'image/jpeg', headers: H, payload: UrlFetchApp.fetch(B + name + '.jpg').getBlob().getBytes() });
    return id;
  };
  const base = make('richmenu'), mac = make('richmenu_mac');
  UrlFetchApp.fetch('https://api.line.me/v2/bot/user/all/richmenu/' + base, { method: 'post', headers: H });          // ふだん（紹介の人）
  UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu/alias/komugi-mac', { method: 'delete', headers: H, muteHttpExceptions: true });
  UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu/alias', { method: 'post', contentType: 'application/json', headers: H, payload: JSON.stringify({ richMenuAliasId: 'komugi-mac', richMenuId: mac }) });
  // もうマー君が友だちなら、ここでつなぐ（スクリプトプロパティ MAC_LINE_ID に、マー君のLINEのID「U…」があれば）
  const macId = PropertiesService.getScriptProperties().getProperty('MAC_LINE_ID');
  if (macId) UrlFetchApp.fetch('https://api.line.me/v2/bot/user/' + macId + '/richmenu/' + mac, { method: 'post', headers: H, muteHttpExceptions: true });
  console.log('コムギのリッチメニュー：ふだん ' + base + '／マー君 ' + mac + (macId ? '（マー君につなぎました）' : ''));
}
