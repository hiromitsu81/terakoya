/* ハタボ サービスサイト 共通スクリプト */
(function(){
  /* ---------- menu ---------- */
  var mb=document.querySelector('.hbh .menu'),nv=document.querySelector('.hbh nav');
  if(mb&&nv)mb.addEventListener('click',function(){nv.classList.toggle('open')});

  /* ---------- consult widget ---------- */
  var SYS=[
   'あなたは「ハタボ」の相談窓口にいるハタボ本人です。ハタボは、LINEで動く、スマホとパソコンの愛棒（AIエージェント）。運営はハタラボ（HATHA LAB）。',
   '話し方：日本語で、ていねいに、短く2〜4文。記号や表はつかわない。',
   'ラインナップ：ハタイエンタ（家族）、ハタリス（個人）、ハタボックス（個人事業）、ハタエース（お店・宿）、ハタボーラ（会社）。大手は法人のお客さまページ。グレードはX（標準）・G（上位）・Z（いちばん上）。',
   '料金の目安（月額・税込み）：ハタリス X 2,980円〜、G 4,980円〜、Z 12,800円〜。ハタイエンタ 家族 5,980円〜（5人まで・1日の回数を家族で分け合う。6人目から1人980円）。ハタボ コネクト（仮称・いつものClaude・ChatGPTにつなぐ）は準備中で月1,480円の予定。ハタボックス 5,000円〜。ハタエース 1拠点10,000円〜＋スタッフ1席1,500円。ハタボーラ 1席2,980円〜（5席から）。月額には、AIの料金・設定・困ったときの伴走まで入っています。年払いは12か月分を10か月分で。',
   'はじめは7日間のお試し（いちばん上のZ、初日30回・2日目から1日15回まで）。7日以内にやめれば0円。',
   '育てた分は残る：覚えたことや性格は、プランを変えても引きつげます。使う人はオーナーズクラブ「AISAI」の仲間になり、祭りやアワードに参加できます。',
   'きまり：住所・電話番号・家族の詳しいこと・体調やお金のくわしいことは聞かない。契約、くわしい見積もり、法人やパートナーの話は「担当におつなぎします」と案内し、法人ページやパートナーページ、プラン・料金ページの見積もりをすすめる。わからないことは、わからないと言う。何のAIで動いているか聞かれたら、うそはつかず「いくつかのAIの会社の仕組みを組み合わせています。くわしくは担当からご説明します」と答える。',
   'ここでの会話は試乗です。気に入ったら、そのままLINEの愛棒としてお迎えできる、と伝えてよい。'
  ].join('\n');
  var FAQ=[
   [/料金|いくら|値段|月額/,'料金は、家族向けのハタイエンタが月5,980円から、個人向けのハタリスが月2,980円からです。月額には、AIの料金や設定、困ったときのお手伝いまで入っています。くわしくは「プラン・料金」の見積もりで、すぐに出せます。'],
   [/試|無料|お試し/,'はじめの7日間は、いちばん上のグレードZを無料でお試しいただけます。7日以内にやめれば0円です。'],
   [/LINE|ライン|アプリ/,'ハタボは、いつものLINEで動くので、アプリを入れる必要はありません。スマホでもパソコンでも話せます。'],
   [/法人|会社|企業|お店|宿/,'お店や会社でのご利用は、法人のお客さまページで、席数や導入の流れをご案内しています。担当からもご連絡できます。'],
   [/AISAI|アイサイ|オーナー/,'AISAIは、ハタボを使う人だけが入れるオーナーズクラブです。祭りやアワード、オーナーサポートがあります。']
  ];
  var LIMIT=12,used=0;try{used=+sessionStorage.getItem('hb_cw')||0}catch(e){}
  var emb=document.querySelector('.hbh .brand img');var src=emb?emb.getAttribute('src'):'award_mark.svg';
  var btn=document.createElement('button');btn.className='cw-btn';btn.type='button';btn.innerHTML='<img src="'+src+'" alt="">相談はこちら';
  var box=document.createElement('div');box.className='cw';box.setAttribute('role','dialog');box.setAttribute('aria-label','ハタボに相談');
  box.innerHTML='<div class="top"><img src="'+src+'" alt=""><div><b>ハタボに相談</b><small>文字でも、声でも。いまの会話が試乗です</small></div><button type="button" aria-label="閉じる">×</button></div><div class="log" aria-live="polite"></div><div class="qk"><button type="button">料金の目安は？</button><button type="button">何ができるの？</button><button type="button">お店で使いたい</button></div><form><button type="button" class="ic mic" title="声で話す" hidden>🎤</button><input placeholder="ハタボに話しかける" aria-label="メッセージ"><button type="button" class="ic spk" title="声で聞く" hidden>🔈</button><button type="submit">送る</button></form><div class="nt">家族の詳しいことや住所は書かないでください。契約やくわしい見積もりは担当におつなぎします。</div>';
  var LM=!(window.claude&&claude.use);
  if(LM){box.innerHTML='<div class="top"><img src="'+src+'" alt=""><div><b>ハタボに申込相談</b><small>公式LINEで、担当のハタボがご案内します</small></div><button type="button" aria-label="閉じる">×</button></div>'+'<div style="padding:16px 18px;font-size:14px;line-height:1.75;color:#16233F"><p style="margin:0 0 10px">ハタボの公式LINEを友だち追加すると、<b>申込相談担当のハタボ</b>と話せます。暮らしやお仕事を聞いて、合うプランをいっしょに選びます。7日間の無料お試しも、そのまま始められます。</p>'+'<ol style="margin:0 0 12px;padding-left:1.3em"><li>下のボタンかQRコードで友だち追加</li><li>トークのカードかメニューの「ハタボに相談」を押す</li><li>申込相談担当のハタボと話す</li></ol><p style="margin:0 0 12px;font-size:13px;color:#5E6B85">担当とのオンライン相談（ビデオ通話・30分・無料）も、LINEのハタボに「オンライン相談したい」と送ると、空いている時間から予約できます。</p>'+'<a href="https://line.me/R/ti/p/@024curid" target="_blank" rel="noopener" style="display:block;text-align:center;background:#06C755;color:#fff;font-weight:800;border-radius:999px;padding:12px;text-decoration:none">LINEで友だち追加</a>'+'<img src="line_qr.png" alt="ハタボ公式LINEのQRコード" class="cw-qr" style="display:block;width:150px;margin:12px auto 0"></div>'+'<div class="log" hidden></div><div class="qk" hidden></div><form hidden><button type="button" class="ic mic" hidden></button><input hidden><button type="button" class="ic spk" hidden></button></form>';btn.innerHTML='<img src="'+src+'" alt="">LINEで申込相談'}
  document.body.appendChild(btn);document.body.appendChild(box);
  var log=box.querySelector('.log'),inp=box.querySelector('input'),form=box.querySelector('form'),mic=box.querySelector('.mic'),spk=box.querySelector('.spk');
  var hist=[],busy=false,sample=null,dict=null,tts=null,speakOn=false;
  function add(t,me){var d=document.createElement('div');d.className='m'+(me?' me':'');d.textContent=t;log.appendChild(d);log.scrollTop=log.scrollHeight;return d}
  add('こんにちは、ハタボです。気になることを、文字か声で聞いてください。');
  btn.addEventListener('click',function(){box.classList.toggle('open');if(box.classList.contains('open')&&!LM)inp.focus()});
  box.querySelector('.top button').addEventListener('click',function(){box.classList.remove('open')});
  box.querySelectorAll('.qk button').forEach(function(b){b.addEventListener('click',function(){send(b.textContent)})});
  form.addEventListener('submit',function(e){e.preventDefault();var t=inp.value.trim();if(t){inp.value='';send(t)}});
  function fallback(t){for(var i=0;i<FAQ.length;i++){if(FAQ[i][0].test(t))return FAQ[i][1]}return 'ありがとうございます。この窓口ではくわしくお答えできないので、担当からご案内します。「プラン・料金」の見積もりや、法人のお客さまページもご覧ください。'}
  function say(t){if(speakOn&&tts){tts.speak(t.slice(0,1900)).catch(function(){})}}
  function send(t){
    if(busy)return;add(t,true);
    if(used>=LIMIT){add('この窓口でのお話は、ここまでとさせてください。続きは、7日間のお試しで、あなたのLINEのハタボとどうぞ。');return}
    used++;try{sessionStorage.setItem('hb_cw',used)}catch(e){}
    hist.push({role:'user',content:t});
    if(!sample){var a=fallback(t);add(a);hist.push({role:'assistant',content:a});say(a);return}
    busy=true;var d=add('…');
    var msgs=[{role:'user',content:SYS+'\n\n（ここから相談）'},{role:'assistant',content:'わかりました。'}].concat(hist.slice(-10));
    sample(msgs,{modelTier:'quick',cache:false,onText:function(o){d.textContent=o.text}}).then(function(r){d.textContent=r.text;hist.push({role:'assistant',content:r.text});say(r.text)}).catch(function(e){var a=fallback(t);d.textContent=a;hist.push({role:'assistant',content:a})}).then(function(){busy=false;log.scrollTop=log.scrollHeight});
  }
  if(window.claude&&claude.use){
    claude.use('sample').then(function(s){sample=s}).catch(function(){});
    claude.use('dictation').then(function(d){if(!d)return;dict=d;mic.hidden=false;
      var base='';d.onPartial(function(o){inp.value=base+o.text});d.onFinal(function(o){base+=o.text;inp.value=base});
      d.onState(function(o){mic.classList.toggle('on',o.state==='listening');if(o.state!=='listening'&&base.trim()){var t=base.trim();base='';inp.value='';send(t)}});
      mic.addEventListener('click',function(){if(mic.classList.contains('on')){d.stop().catch(function(){})}else{base='';d.start().catch(function(){mic.hidden=true})}});
    }).catch(function(){});
    claude.use('tts').then(function(t){if(!t)return;tts=t;spk.hidden=false;spk.addEventListener('click',function(){speakOn=!speakOn;spk.classList.toggle('on',speakOn);if(!speakOn)t.stop()})}).catch(function(){});
  }

  /* ---------- simulator ---------- */
  var sim=document.getElementById('sim');if(!sim)return;
  var L={
   ietna:{n:'ハタイエンタ（家族）',g:{X:[['家族で1日150回（1人60回まで）',5980]],G:[['家族で1日100回（1人40回まで）',12800]]},note:'5人まで。6人目から1人月980円。足りない日は追加チケット（1,000円で40回から）。'},
   ris:{n:'ハタリス（個人）',g:{X:[['1日60回まで',2980]],G:[['1日40回まで',4980]],Z:[['1日30回まで',12800]]}},
   box:{n:'ハタボックス（個人事業）',g:{X:[['1日60回まで',5000]]},note:'Gは担当からご案内します。'},
   ace:{n:'ハタエース（お店・宿）',seat:1500,base:10000,g:{X:[['1拠点（窓口 1日60回まで）',10000]]},note:'スタッフ1席ごとに月1,500円。立ち上げの初期費用は個別にお見積もりします。'},
   bora:{n:'ハタボーラ（会社）',per:true,g:{X:[['1席（1日60回まで）',2980]],G:[['1席（1日40回まで）',9800]]},note:'5席から。10席以上10%、50席以上15%、100席以上20%引き。'}
  };
  var ALL=['ietna','ris','box','ace','bora'];
  var OP=[['mimamori','見守り報告（家族のLINEへ）',300,['ietna','ris']],['gaku','学習モード（英語・中国語）',980,['ietna','ris','box']],['add','愛棒の追加（1体）',980,['ietna','ris','box']],['lw','LINEでも使う（書く・見る）',300,['ietna','ris','box']],['chara','キャラ・話し方のカスタム',500,ALL],['avatar','アバターの作成（オリジナルの見た目）',0,ALL,9800],['orig','オリジナルキャラクター（専用の公式LINEとミニアプリ・見た目・性格・声）10万円から',0,ALL,100000],['rename','名前の変更（最初の名付けは無料）',0,ALL,1000],['voice','オリジナルの声（好きな声・本人の声）',980,ALL,29800],['emo','表情ゆたかな声（気持ちと間が出る声。Zとオリジナルキャラは込み）',500,ALL],['lang','外国語の窓口',3000,['ace']],['line','LINE公式アカウント連携（書く・見る）',5000,['ace','bora']]];
  var st={l:'ris',g:'X',t:0,n:5,o:{},pay:'m'};
  try{var q=new URLSearchParams(location.search).get('l');if(q&&L[q])st.l=q}catch(e){}
  if(location.hash&&L[location.hash.slice(1)])st.l=location.hash.slice(1);
  var $=function(s){return sim.querySelector(s)};
  function yen(v){return v.toLocaleString('ja-JP')+'円'}
  function render(){
    var m=L[st.l];if(!m.g[st.g])st.g=Object.keys(m.g)[0];var tiers=m.g[st.g];if(st.t>=tiers.length)st.t=0;
    $('#s-l').innerHTML=Object.keys(L).map(function(k){return '<label><input type="radio" name="l" value="'+k+'"'+(k===st.l?' checked':'')+'>'+L[k].n+'</label>'}).join('');
    $('#s-g').innerHTML=['X','G','Z'].map(function(g){var ok=!!m.g[g];return '<label style="'+(ok?'':'opacity:.4')+'"><input type="radio" name="g" value="'+g+'"'+(g===st.g?' checked':'')+(ok?'':' disabled')+'>'+g+(g==='X'?'（標準）':g==='G'?'（上位）':'（いちばん上）')+'</label>'}).join('');
    $('#s-t').innerHTML=tiers.map(function(t,i){return '<label><input type="radio" name="t" value="'+i+'"'+(i===st.t?' checked':'')+'>'+t[0]+'</label>'}).join('');
    var showN=m.per||m.seat;$('#s-nf').hidden=!showN;$('#s-nl').textContent=m.per?'席数（5席から）':'スタッフの席数';
    $('#s-o').innerHTML=OP.filter(function(o){return o[3].indexOf(st.l)>=0&&!(o[0]==='emo'&&st.g==='Z')}).map(function(o){return '<label><input type="checkbox" name="o" value="'+o[0]+'"'+(st.o[o[0]]?' checked':'')+'>'+o[1]+'　'+(o[2]?'+'+yen(o[2])+'／月':'')+(o[4]?(o[2]?'・':'')+'初回 '+yen(o[4]):'')+'</label>'}).join('');
    var base=tiers[st.t][1],lines=[];
    if(m.per){var n=Math.max(5,st.n|0);var disc=n>=100?.2:n>=50?.15:n>=10?.1:0;base=Math.round(base*n*(1-disc));lines.push(n+'席'+(disc?'（席数割 '+disc*100+'%）':''))}
    else if(m.seat){var n2=Math.max(0,st.n|0);base+=m.seat*n2;lines.push('スタッフ'+n2+'席')}
    var opt=0,once=0;OP.forEach(function(o){if(st.o[o[0]]&&o[3].indexOf(st.l)>=0&&!(o[0]==='emo'&&st.g==='Z')){opt+=o[2];once+=(o[4]||0);lines.push(o[1])}});
    if(document.activeElement!==$('#s-n'))$('#s-n').value=st.n;
    var mon=base+opt,shown=st.pay==='y'?Math.round(mon*10/12):mon;
    $('#r-n').textContent=m.n+' '+st.g;$('#r-p').innerHTML=yen(shown)+'<small>／月</small>';
    $('#r-y').textContent=st.pay==='y'?'年払い：1年で'+yen(mon*10)+'（12か月分を10か月分の料金で）':'月払い：初期費用0円、いつでも見直せます';
    $('#r-l').innerHTML=[tiers[st.t][0]].concat(lines).map(function(x){return '<li>'+x+'</li>'}).join('')+'<li>AIの料金・設定・伴走は月額に込み</li>'+(once?'<li><b>初回のみ '+yen(once)+'</b>（アバター・名前・声の作成）</li>':'');
    $('#r-note').textContent=m.note||'';
    try{localStorage.setItem('hb_quote',JSON.stringify({l:m.n,g:st.g,t:tiers[st.t][0],price:shown,pay:st.pay}))}catch(e){}
  }
  sim.addEventListener('change',function(e){var t=e.target;if(t.name==='l'){st.l=t.value;st.g='X';st.t=0;st.n=st.l==='bora'?5:0;st.o={}}else if(t.name==='g'){st.g=t.value;st.t=0}else if(t.name==='t')st.t=+t.value;else if(t.name==='o')st.o[t.value]=t.checked;else if(t.name==='pay')st.pay=t.value;else if(t.id==='s-n')st.n=+t.value;render()});
  sim.addEventListener('input',function(e){if(e.target.id==='s-n'){st.n=+e.target.value;render()}});
  if(st.l==='bora')st.n=5;else st.n=0;$('#s-n').value=st.n;render();
})();

/* TOPのエンブレム：スクロールで回転が速くなる */
(function(){
  var R1=[].slice.call(document.querySelectorAll('.kvh .eng .r1,.ph2 .eng .r1')),R2=[].slice.call(document.querySelectorAll('.kvh .eng .r2,.ph2 .eng .r2'));
  if(!R1.length)return;
  if(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  var a=0,b=0,boost=0,lastY=window.scrollY,lastT=performance.now();
  window.addEventListener('scroll',function(){
    var y=window.scrollY,d=Math.abs(y-lastY);lastY=y;
    boost=Math.min(boost+d*0.3,80);
  },{passive:true});
  function tick(t){
    var dt=Math.min(t-lastT,50);lastT=t;
    var sp=7+boost;
    a=(a+sp*dt/16)%360; b=(b-(4.5+boost*0.7)*dt/16)%360;
    R1.forEach(function(e){e.style.transform='rotate('+a+'deg)'}); R2.forEach(function(e){e.style.transform='rotate('+b+'deg)'});
    boost*=Math.pow(0.94,dt/16);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
