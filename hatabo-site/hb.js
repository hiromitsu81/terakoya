/* ハタボ サービスサイト 共通スクリプト */
(function(){
  /* ---------- menu ---------- */
  var mb=document.querySelector('.hbh .menu'),nv=document.querySelector('.hbh nav');
  if(mb&&nv){mb.setAttribute('aria-expanded','false');mb.addEventListener('click',function(){var o=nv.classList.toggle('open');mb.setAttribute('aria-expanded',o?'true':'false');mb.textContent=o?'とじる':'メニュー'});
   /* 今いるページのタブを見える位置に */
   var cur=location.pathname.split('/').pop()||'index.html';[].forEach.call(nv.querySelectorAll('a'),function(a){if(a.getAttribute('href')===cur&&a.offsetParent){a.classList.add('on');try{nv.scrollLeft=a.getBoundingClientRect().left-nv.getBoundingClientRect().left-12}catch(e){}}})}

  /* ファーストビューのカルーセルが見えている間は、右下のボタンをかくす */
  var fvv=document.querySelector('.fv');if(fvv&&'IntersectionObserver'in window)new IntersectionObserver(function(es){document.body.classList.toggle('fvon',es[0].isIntersecting&&es[0].intersectionRatio>.35)},{threshold:[0,.35,.6]}).observe(fvv);
  /* ---------- スマホのカルーセル ---------- */
  var mqc=window.matchMedia?matchMedia('(max-width:760px)'):null;
  [].forEach.call(document.querySelectorAll('.trg,.scg,.gkl,.lugrid,.kp3,[data-car]'),function(el){
   var n=el.children.length;if(n<2)return;el.classList.add('mcar');
   var bar=document.createElement('div');bar.className='mcbar';bar.innerHTML='<button type="button" class="pv" aria-label="前へ"></button><i><b></b></i><span>1 / '+n+'</span><button type="button" class="nx" aria-label="次へ"></button>';
   el.parentNode.insertBefore(bar,el.nextSibling);
   var th=bar.querySelector('b'),ct=bar.querySelector('span'),pv=bar.querySelector('.pv'),nx=bar.querySelector('.nx');
   function step(){var c=el.children[0],c2=el.children[1];return c2?c2.offsetLeft-c.offsetLeft:el.clientWidth}
   function up(){var sw=el.scrollWidth,cw=el.clientWidth,mx=sw-cw;if(sw<=0)return;var w=Math.max(12,cw/sw*100),r=mx>0?el.scrollLeft/mx:0;th.style.width=w+'%';th.style.left=(r*(100-w))+'%';var i=mx>0&&el.scrollLeft>=mx-4?n:Math.round(el.scrollLeft/step())+1;ct.textContent=Math.min(n,Math.max(1,i))+' / '+n;pv.disabled=el.scrollLeft<4;nx.disabled=el.scrollLeft>=mx-4}
   var tk2=0;el.addEventListener('scroll',function(){if(!tk2){tk2=1;requestAnimationFrame(function(){tk2=0;up()})}},{passive:true});
   pv.addEventListener('click',function(){el.scrollBy({left:-step(),behavior:'smooth'})});nx.addEventListener('click',function(){el.scrollBy({left:step(),behavior:'smooth'})});
   addEventListener('resize',up);setTimeout(up,60);up();
  });

  /* ---------- consult widget ---------- */
  var P=window.HB_CW||null;var SYS=(P&&P.sys?P.sys:[]).concat([
   'あなたは「ハタボ」の相談窓口にいるハタボ本人です。ハタボは、LINEで動く、スマホとパソコンの愛棒（AIエージェント）。運営はハタラボ（HATHA LAB）。',
   '話し方：日本語で、ていねいに、短く2〜4文。記号や表はつかわない。',
   'ラインナップ：ハタイエンタ（家族）、ハタリス（個人）、ハタボックス（個人事業）、ハタエース（お店・宿）、ハタボーラ（会社）。大手は法人のお客さまページ。グレードはX（標準）・G（上位）・Z（いちばん上）。',
   '料金の目安（月額・税込み）：ハタリス X 2,980円〜、G 4,980円〜、Z 12,800円〜。ハタイエンタ 家族 5,980円〜（5人まで・1日の回数を家族で分け合う。6人目から1人980円）。ハタボ コネクト（仮称・いつものClaude・ChatGPTにつなぐ）は準備中で月1,480円の予定。ハタボックス 5,000円〜。ハタエース 1拠点10,000円〜＋スタッフ1席1,500円。ハタボーラ 1席2,980円〜（5席から）。月額には、AIの料金・設定・困ったときの伴走まで入っています。年払いは12か月分を10か月分で。',
   'はじめは7日間のお試し（いちばん上のZ、初日30回・2日目から1日15回まで）。7日以内にやめれば0円。',
   '育てた分は残る：覚えたことや性格は、プランを変えても引きつげます。使う人はオーナーズクラブの仲間になり、祭りやアワードに参加できます。',
   'きまり：住所・電話番号・家族の詳しいこと・体調やお金のくわしいことは聞かない。契約、くわしい見積もり、法人やパートナーの話は「担当におつなぎします」と案内し、法人ページやパートナーページ、プラン・料金ページの見積もりをすすめる。わからないことは、わからないと言う。何のAIで動いているか聞かれたら、うそはつかず「いくつかのAIの会社の仕組みを組み合わせています。くわしくは担当からご説明します」と答える。',
   'ここでの会話は試乗です。気に入ったら、そのままLINEの愛棒としてお迎えできる、と伝えてよい。'
  ]).join('\n');
  var FAQ=(P&&P.faq?P.faq:[]).concat([
   [/料金|いくら|値段|月額/,'料金は、家族向けのハタイエンタが月5,980円から、個人向けのハタリスが月2,980円からです。月額には、AIの料金や設定、困ったときのお手伝いまで入っています。くわしくは「プラン・料金」の見積もりで、すぐに出せます。'],
   [/試|無料|お試し/,'はじめの7日間は、いちばん上のグレードZを無料でお試しいただけます。7日以内にやめれば0円です。'],
   [/LINE|ライン|アプリ/,'ハタボは、いつものLINEで動くので、アプリを入れる必要はありません。スマホでもパソコンでも話せます。'],
   [/法人|会社|企業|お店|宿/,'お店や会社でのご利用は、法人のお客さまページで、席数や導入の流れをご案内しています。担当からもご連絡できます。'],
   [/AISAI|アイサイ|オーナー/,'オーナーズクラブは、ハタボを使う人だけが入れる仲間です。中では AISAI＝愛祭 と呼んでいて、祭りやアワード、オーナーサポートがあります。']
  ]);
  var LIMIT=12,used=0;try{used=+sessionStorage.getItem('hb_cw')||0}catch(e){}
  var emb=document.querySelector('.hbh .brand img');var src=emb?emb.getAttribute('src'):'award_mark.svg';
  var btn=document.createElement('button');btn.className='cw-btn';btn.type='button';btn.innerHTML='<img src="'+src+'" alt="">'+(P&&P.btn||'相談はこちら');if(P)btn.classList.add('cw-p');
  var box=document.createElement('div');box.className='cw';box.setAttribute('role','dialog');box.setAttribute('aria-label','ハタボに相談');
  box.innerHTML='<div class="top"><img src="'+src+'" alt=""><div><b>'+(P&&P.title||'ハタボに相談')+'</b><small>'+(P&&P.sub||'文字でも、声でも。いまの会話が試乗です')+'</small></div><button type="button" aria-label="閉じる">×</button></div><div class="log" aria-live="polite"></div><div class="qk">'+(P&&P.qk?P.qk:['料金の目安は？','何ができるの？','お店で使いたい']).map(function(x){return '<button type="button">'+x+'</button>'}).join('')+'</div><form><button type="button" class="ic mic" title="声で話す" hidden>🎤</button><input placeholder="ハタボに話しかける" aria-label="メッセージ"><button type="button" class="ic spk" title="声で聞く" hidden>🔈</button><button type="submit">送る</button></form><div class="nt">家族の詳しいことや住所は書かないでください。契約やくわしい見積もりは担当におつなぎします。</div>';
  var LM=!(window.claude&&claude.use);
  if(LM&&P&&P.lm){box.innerHTML='<div class="top"><img src="'+src+'" alt=""><div><b>'+P.title+'</b><small>'+P.sub+'</small></div><button type="button" aria-label="閉じる">×</button></div>'+P.lm+'<div class="log" hidden></div><div class="qk" hidden></div><form hidden><button type="button" class="ic mic" hidden></button><input hidden><button type="button" class="ic spk" hidden></button></form>';btn.innerHTML='<img src="'+src+'" alt="">'+P.btn}else if(LM){box.innerHTML='<div class="top"><img src="'+src+'" alt=""><div><b>ハタボに申込相談</b><small>公式LINEで、担当のハタボがご案内します</small></div><button type="button" aria-label="閉じる">×</button></div>'+'<div style="padding:16px 18px;font-size:14px;line-height:1.75;color:#16233F"><p style="margin:0 0 10px">ハタボの公式LINEを友だち追加すると、<b>申込相談担当のハタボ</b>と話せます。暮らしやお仕事を聞いて、合うプランをいっしょに選びます。7日間の無料お試しも、そのまま始められます。</p>'+'<ol style="margin:0 0 12px;padding-left:1.3em"><li>下のボタンかQRコードで友だち追加</li><li>トークのカードかメニューの「ハタボに相談」を押す</li><li>申込相談担当のハタボと話す</li></ol><p style="margin:0 0 12px;font-size:13px;color:#5E6B85">担当とのオンライン相談（ビデオ通話・30分・無料）も、LINEのハタボに「オンライン相談したい」と送ると、空いている時間から予約できます。</p>'+'<a href="https://line.me/R/ti/p/@024curid" target="_blank" rel="noopener" style="display:block;text-align:center;background:#06C755;color:#fff;font-weight:800;border-radius:999px;padding:12px;text-decoration:none">LINEで友だち追加</a>'+'<img src="line_qr.png" alt="ハタボ公式LINEのQRコード" class="cw-qr" style="display:block;width:150px;margin:12px auto 0"></div>'+'<div class="log" hidden></div><div class="qk" hidden></div><form hidden><button type="button" class="ic mic" hidden></button><input hidden><button type="button" class="ic spk" hidden></button></form>';btn.innerHTML='<img src="'+src+'" alt="">LINEで申込相談'}
  document.body.appendChild(btn);document.body.appendChild(box);
  var log=box.querySelector('.log'),inp=box.querySelector('input'),form=box.querySelector('form'),mic=box.querySelector('.mic'),spk=box.querySelector('.spk');
  var hist=[],busy=false,sample=null,dict=null,tts=null,speakOn=false;
  function add(t,me){var d=document.createElement('div');d.className='m'+(me?' me':'');d.textContent=t;log.appendChild(d);log.scrollTop=log.scrollHeight;return d}
  add(P&&P.hello||'こんにちは、ハタボです。気になることを、文字か声で聞いてください。');if(P&&P.peek){var pk=document.createElement('div');pk.className='cw-peek';pk.innerHTML=P.peek+'<button type="button" aria-label="閉じる">×</button>';document.body.appendChild(pk);setTimeout(function(){pk.classList.add('on');document.body.classList.add('hb-peek')},1600);pk.addEventListener('click',function(e){pk.classList.remove('on');document.body.classList.remove('hb-peek');if(e.target.tagName!=='BUTTON')btn.click()})}window.HB_CW_OPEN=function(t){box.classList.add('open');if(t&&!LM)send(t)};
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

  /* ---------- simulator：その人の前提から順番に聞いて、「はじめの費用・固定・従量」に分けて出す ---------- */
  var sim=document.getElementById('sim');if(!sim)return;
  var L={
   ietna:{n:'ハタイエンタ',cn:3980,no:{Z:'ハタイエンタはXとGまで'},g:{X:5980,G:12800},cap:{X:'家族で1日150回（1人60回まで）',G:'家族で1日100回（1人40回まで）'},cnt:{label:'家族の人数',min:1,def:4,free:5,each:980},note:'5人まで。6人目から1人月980円。'},
   ris:{n:'ハタリス',cn:1980,no:{},g:{X:2980,G:4980,Z:12800},cap:{X:'1日60回まで',G:'1日40回まで',Z:'1日30回まで'}},
   box:{n:'ハタボックス',cn:3300,no:{G:'G・Zは担当からご案内',Z:'G・Zは担当からご案内'},g:{X:5000},cap:{X:'1日60回まで'},note:'G・Zは担当からご案内します。'},
   ace:{n:'ハタエース',cn:6600,cnSeat:1000,no:{G:'Gは担当からご案内',Z:'お店はXとGまで'},g:{X:10000},cap:{X:'1拠点（窓口 1日60回まで）'},cnt:{label:'スタッフの席数',min:0,def:1,free:0,each:1500},note:'立ち上げの初期費用は個別にお見積もりします。',shop:true},
   bora:{n:'ハタボーラ',cn:1980,no:{Z:'会社はXとGまで（その上は法人で相談）'},g:{X:2980,G:9800},cap:{X:'1席 1日60回まで',G:'1席 1日40回まで'},cnt:{label:'席数（5席から）',min:5,def:5,seat:true},note:'10席以上10%、50席以上15%、100席以上20%引き。',shop:true}
  };
  var WHO=[['family','家族で使う','ietna'],['me','ひとりで使う','ris'],['solo','個人事業で使う','box'],['shop','お店・宿で使う','ace'],['corp','会社（法人）で使う','bora']];
  var ALL=['ietna','ris','box','ace','bora'];
  var OP=[['mimamori','見守り報告（家族のLINEへ）',300,['ietna','ris']],['gaku','学習モード（英語・中国語）',980,['ietna','ris','box']],['add','愛棒の追加（1体）',980,['ietna','ris','box']],['lw','LINEでも使う（書く・見る）',300,['ietna','ris','box']],['chara','キャラ・話し方のカスタム',500,ALL],['avatar','アバターの作成（オリジナルの見た目）',0,ALL,9800],['rename','名前の変更（最初の名付けは無料）',0,ALL,1000],['voice','オリジナルの声（好きな声・本人の声）',980,ALL,29800],['emo','表情ゆたかな声（Zは込み）',500,ALL],['lang','外国語の窓口',3000,['ace']]];
  var WIN=[['share','持っていない（ハタボの公式LINEに相乗り）','0円',ALL],['own','持っている（自分の公式LINEにつなぐ）','月5,000円・はじめの設定0円',['ace','bora']],['orig','新しく作りたい（専用の公式LINEとミニアプリ・見た目・性格・声）','初期10万円から',ALL]];
  var BASE=[['fix','土台固定：ハタボのAIがエンジン（グレードの月額に込み）',ALL],['conn','ハタボ コネクト（従量）：いつものAIがエンジン。車種はボディの料金に。月100回まで無料',ALL],['plus','ハタボ コネクト プラス：同じくボディの料金＋月1,480円で2,000回込み（準備中）',ALL],['addon','自社のAIを土台に（アドオン型・1席1,000円・10席から）',['bora']]];
  var P={free:100,plusFree:2000,plus:1480,search:1,msg:5,done:30,famAdd:500,own:5000,orig:100000};
  var st={who:'me',l:'ris',g:'X',n:0,w:'share',b:'fix',o:{},pay:'m',us:50,um:20,ud:0,f:0};
  try{var q=new URLSearchParams(location.search).get('l');if(q&&L[q]){st.l=q;WHO.forEach(function(w){if(w[2]===q)st.who=w[0]})}}catch(e){}
  if(location.hash&&L[location.hash.slice(1)]){st.l=location.hash.slice(1);WHO.forEach(function(w){if(w[2]===st.l)st.who=w[0]})}
  var $=function(s){return sim.querySelector(s)};
  function yen(v){return Math.round(v).toLocaleString('ja-JP')+'円'}
  function radios(name,list,cur,ok){return list.map(function(x){var en=ok?ok(x):true;return '<label style="'+(en?'':'opacity:.45')+'"><input type="radio" name="'+name+'" value="'+x[0]+'"'+(x[0]===cur?' checked':'')+(en?'':' disabled')+'>'+x[1]+(x[2]&&typeof x[2]==='string'?'<small style="display:block;color:#6B7385;font-size:11.5px">'+x[2]+(en?'':'（お店・会社）')+'</small>':'')+'</label>'}).join('')}
  function num(id,label,v,min,max){return '<label style="display:flex;flex-direction:row;align-items:center;justify-content:space-between;gap:12px;text-align:left;font-size:13.5px">'+label+'<input type="number" id="'+id+'" min="'+min+'" max="'+max+'" value="'+v+'" style="width:120px;flex:none"></label>'}
  function render(){
    var m=L[st.l];
    if(!m.g[st.g])st.g=Object.keys(m.g)[0];
    var okW=function(x){return x[3].indexOf(st.l)>=0},okB=function(x){return x[2].indexOf(st.l)>=0};
    if(!okW(WIN.filter(function(x){return x[0]===st.w})[0]))st.w='share';
    if(!okB(BASE.filter(function(x){return x[0]===st.b})[0]))st.b='fix';
    $('#s-who').innerHTML=radios('who',WHO.map(function(w){return [w[0],w[1]+'（'+L[w[2]].n+'）']}),st.who);
    var c=m.cnt;$('#s-nf').hidden=!c;if(c){$('#s-nl').textContent=c.label;if(document.activeElement!==$('#s-n')){$('#s-n').min=c.min;$('#s-n').value=st.n}}
    $('#s-w').innerHTML=radios('w',WIN,st.w,okW);
    var conn=st.b==='conn'||st.b==='plus';
    $('#s-g').innerHTML=(conn?'<p style="margin:0 0 6px;font-size:12.5px;color:#6B7385">コネクトは、いつものAIがエンジンなので、グレードはありません。</p>':'')+['X','G','Z'].map(function(g){var ok=!!m.g[g]&&!conn;return '<label style="'+(ok?'':'opacity:.45')+'"><input type="radio" name="g" value="'+g+'"'+(g===st.g&&!conn?' checked':'')+(ok?'':' disabled')+'>'+g+(g==='X'?'（標準）':g==='G'?'（上位）':'（いちばん上）')+'<small style="display:block;color:#6B7385;font-size:11.5px">'+(conn?'コネクトでは選びません':m.g[g]?m.cap[g]:(m.no[g]||'この車種では選べません'))+'</small></label>'}).join('');
    $('#s-b').innerHTML=radios('b',BASE.map(function(b){return [b[0],b[1],'',b[2]]}),st.b,function(x){return BASE.filter(function(b){return b[0]===x[0]})[0][2].indexOf(st.l)>=0});
    var useOn=st.b==='conn'||st.b==='plus';$('#s-uf').hidden=!useOn;
    if(useOn&&!(document.activeElement&&/^s-u/.test(document.activeElement.id||''))){
      $('#s-u').innerHTML=num('s-us','「さがす」の回数（1回1円）',st.us,0,100000)+num('s-um','「伝言・予約の希望」の回数（1回5円）',st.um,0,100000)+(m.shop?num('s-ud','AIから届いた予約の成立（1件30円）',st.ud,0,100000):'')+(st.b==='plus'&&st.l==='ietna'?num('s-f','コネクトの家族追加（1人月500円）',st.f,0,20):'');
    }
    $('#s-o').innerHTML=OP.filter(function(o){return o[3].indexOf(st.l)>=0&&!(o[0]==='emo'&&st.g==='Z')}).map(function(o){return '<label><input type="checkbox" name="o" value="'+o[0]+'"'+(st.o[o[0]]?' checked':'')+'>'+o[1]+'　'+(o[2]?'+'+yen(o[2])+'／月':'')+(o[4]?(o[2]?'・':'')+'初回 '+yen(o[4]):'')+'</label>'}).join('');
    // 計算：固定（毎月）・従量（使った分）・はじめの費用
    var fixed=[],vari=[],once=[],F=0,V=0,O=0;
    var base=conn?m.cn:m.g[st.g],lab=m.n+' '+(conn?'コネクト（ボディだけ）':st.g);
    if(st.l==='bora'){var n=st.b==='addon'?Math.max(10,st.n|0):Math.max(5,st.n|0);if(st.b==='addon'){F+=1000*n;fixed.push(['アドオン型 '+n+'席（AIは自社の契約）',1000*n])}else{var disc=n>=100?.2:n>=50?.15:n>=10?.1:0;var b2=base*n*(1-disc);F+=b2;fixed.push([lab+' '+n+'席'+(disc?'（席数割 '+disc*100+'%）':''),b2])}}
    else{F+=base;fixed.push([lab,base]);if(c&&c.each){var each=conn&&m.cnSeat?m.cnSeat:c.each,extra=Math.max(0,(st.n|0)-(c.free||0));if(extra){F+=extra*each;fixed.push([(st.l==='ace'?'スタッフ ':'6人目からの家族 ')+extra+(st.l==='ace'?'席':'人'),extra*each])}}}
    if(st.b==='plus'){F+=P.plus;fixed.push(['ハタボ コネクト プラス（準備中）',P.plus]);if(st.l==='ietna'&&st.f>0){F+=st.f*P.famAdd;fixed.push(['コネクトの家族追加 '+st.f+'人',st.f*P.famAdd])}}
    if(st.w==='own'){F+=P.own;fixed.push(['自分の公式LINEにつなぐ',P.own])}
    OP.forEach(function(o){if(st.o[o[0]]&&o[3].indexOf(st.l)>=0&&!(o[0]==='emo'&&st.g==='Z')){if(o[2]){F+=o[2];fixed.push([o[1],o[2]])}if(o[4]){O+=o[4];once.push([o[1],o[4]])}}});
    if(st.w==='orig'){O+=P.orig;once.push(['専用の公式LINEとミニアプリを新しく作る（10万円から）',P.orig])}
    var over=0;
    if(useOn){var tot=(st.us|0)+(st.um|0),freeN=st.b==='plus'?P.plusFree:P.free;over=Math.max(0,tot-freeN);
      if(over){var oS=Math.round((st.us|0)*over/tot),oM=over-oS,v=oS*P.search+oM*P.msg;V+=v;vari.push(['コネクト：'+freeN.toLocaleString('ja-JP')+'回をこえた '+over.toLocaleString('ja-JP')+'回（さがす'+oS+'・伝言'+oM+'）',v])}
      else vari.push(['コネクト：'+tot.toLocaleString('ja-JP')+'回（'+freeN.toLocaleString('ja-JP')+'回まで込み）',0]);
      if(m.shop&&st.ud>0){V+=st.ud*P.done;vari.push(['AIから届いた予約の成立 '+st.ud+'件',st.ud*P.done])}}
    var shownF=st.pay==='y'?F*10/12:F;
    $('#r-n').textContent=m.n+' '+(st.b==='addon'?'アドオン型':conn?'コネクト':st.g);
    $('#r-p').innerHTML=yen(shownF+V)+'<small>／月の目安（固定＋従量）</small>';
    $('#r-y').textContent=st.pay==='y'?'年払い：固定の分が1年で'+yen(F*10)+'（12か月分を10か月分の料金で）':'月払い：いつでも見直せます';
    var row=function(x){return '<div style="display:flex;justify-content:space-between;gap:8px;font-size:12.5px;line-height:1.6"><span>'+x[0]+'</span><b style="white-space:nowrap">'+yen(x[1])+'</b></div>'};
    var box=function(t,sum,list,note){return '<div style="border:1px solid rgba(255,255,255,.2);border-radius:12px;padding:12px;display:grid;gap:4px;align-content:start"><span style="font-size:12px;color:#C6CBDB">'+t+'</span><b style="font-size:22px">'+yen(sum)+'</b>'+list.map(row).join('')+(note?'<span style="font-size:11.5px;color:#C6CBDB">'+note+'</span>':'')+'</div>'};
    $('#r-l').innerHTML='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">'+box('はじめの費用（1回だけ）',O,once.length?once:[['なし',0]],'')+box('毎月の固定',shownF,fixed,st.pay==='y'?'年払いを月あたりにした金額':'')+'</div>'+box('従量（目安）',V,vari.length?vari:[['使った分はかかりません',0]],useOn?'入れた回数での見こみです。使った分で毎月変わります。'+(st.b==='plus'?'2,000回をこえた分も、さがす1円・伝言5円。':'101回目から。'):'土台固定はAIの料金も月額に込み');
    $('#r-note').textContent=(m.note||'')+(st.b==='plus'?' コネクト プラスは準備中です。':'')+(st.w==='own'?' LINEの送信料はお店のLINEのプランで。':'');
    try{localStorage.setItem('hb_quote',JSON.stringify({l:m.n,g:st.g,price:Math.round(shownF+V),fixed:Math.round(shownF),usage:V,once:O,pay:st.pay,base:st.b,win:st.w}))}catch(e){}
  }
  sim.addEventListener('change',function(e){var t=e.target;
    if(t.name==='who'){st.who=t.value;WHO.forEach(function(w){if(w[0]===st.who)st.l=w[2]});st.g='X';st.o={};var c=L[st.l].cnt;st.n=c?c.def:0;st.ud=0;st.f=0}
    else if(t.name==='g')st.g=t.value;else if(t.name==='w')st.w=t.value;else if(t.name==='b'){st.b=t.value;if(st.b==='addon'&&st.n<10)st.n=10}
    else if(t.name==='o')st.o[t.value]=t.checked;else if(t.name==='pay')st.pay=t.value;
    else if(t.id==='s-n')st.n=+t.value;else if(t.id==='s-us')st.us=+t.value;else if(t.id==='s-um')st.um=+t.value;else if(t.id==='s-ud')st.ud=+t.value;else if(t.id==='s-f')st.f=Math.max(0,Math.min(20,+t.value||0));
    render()});
  sim.addEventListener('input',function(e){var id=e.target.id,v=+e.target.value||0;if(id==='s-n')st.n=v;else if(id==='s-us')st.us=v;else if(id==='s-um')st.um=v;else if(id==='s-ud')st.ud=v;else if(id==='s-f')st.f=Math.max(0,Math.min(20,v));else return;render()});
  {var c0=L[st.l].cnt;st.n=c0?c0.def:0}
  render();
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
  /* ---------- ブランドの色（サイト全体）：ハタボ・話す＝緑、AI＝青、愛棒＝赤、聞く・読む・書く＝それぞれの色 ---------- */
(function(){
    var skip={SCRIPT:1,STYLE:1,TEXTAREA:1,INPUT:1,OPTION:1,TITLE:1,svg:1};
    function walk(root,re,heads){
      var w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:function(n){
        for(var p=n.parentNode;p&&p!==root.parentNode;p=p.parentNode){if(skip[p.nodeName]||(p.classList&&/\b(k-hb|k-ai|k-love|v-talk|v-listen|v-read|v-write|v-see)\b/.test(p.className||'')))return NodeFilter.FILTER_REJECT;if(p.closest&&p.closest('svg'))return NodeFilter.FILTER_REJECT}
        re.lastIndex=0;return re.test(n.nodeValue)?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT}});
      var list=[];while(w.nextNode())list.push(w.currentNode);
      list.forEach(function(n){
        var f=document.createDocumentFragment(),t=n.nodeValue,last=0;re.lastIndex=0;var m;
        while((m=re.exec(t))){f.appendChild(document.createTextNode(t.slice(last,m.index)));var sp=document.createElement('span');sp.className=({'ハタボ':'k-hb','AI':'k-ai','愛棒':'k-love','話す':'v-talk','聞く':'v-listen','読む':'v-read','書く':'v-write','見る':'v-see'})[m[0]];sp.textContent=m[0];f.appendChild(sp);last=m.index+m[0].length}
        f.appendChild(document.createTextNode(t.slice(last)));n.parentNode.replaceChild(f,n)})}
    function run(){
      walk(document.body,/ハタボ(?!ー)|(?<![A-Za-z])AI(?![A-Za-z])|愛棒|話す|聞く|読む|書く|見る/g)}
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run);else run();
  })();


/* motion kit */
(function(){if(window.__hbmk)return;window.__hbmk=1;var rm=matchMedia("(prefers-reduced-motion: reduce)").matches;
function ready(f){document.readyState!="loading"?f():document.addEventListener("DOMContentLoaded",f)}
ready(function(){var b=document.body;if(!b)return;
/* progress bar + header shadow + back-to-top */
var pg=document.createElement("div");pg.className="hbprog";b.appendChild(pg);
var tp=document.createElement("button");tp.className="hbtop";tp.setAttribute("aria-label","ページの上へ");tp.textContent="↑";b.appendChild(tp);
tp.addEventListener("click",function(){window.scrollTo({top:0,behavior:rm?"auto":"smooth"})});
var hd=document.querySelector(".hbh"),tk=0;function onS(){tk=0;var y=window.scrollY,h=document.documentElement.scrollHeight-innerHeight;pg.style.setProperty("--p",h>0?(y/h).toFixed(4):0);if(hd)hd.classList.toggle("scd",y>8);tp.classList.toggle("on",y>innerHeight*1.2)}
addEventListener("scroll",function(){if(!tk){tk=1;requestAnimationFrame(onS)}},{passive:true});onS();
if(rm||!("IntersectionObserver"in window))return;
/* scroll reveal */
var sel=".gkl>li,.rkl>li,.kicker,.eye,.h2,.h3,h2,.lead,.lead2,.cd,.lu,.scn,.ind,.qa,.tbx,.opts>*,.pc,.sim,.bb,.r1,.r2,.ph,.vis,.shiftband,.archw,section .wrap>p,section .wr>p,.ic>h2,.ic>p";
var els=[].slice.call(document.querySelectorAll(sel)).filter(function(e){return !e.closest(".hbh,.hbf,.rv,.hv,svg,.mq,.ctab")&&!e.classList.contains("rv")&&!e.querySelector(".rv")});
var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add("hbin");io.unobserve(e.target)}})},{rootMargin:"0px 0px -6% 0px",threshold:.04});
els.forEach(function(e){var r=e.getBoundingClientRect();if(r.top<innerHeight*.92)return;var p=e.parentNode,sib=[].filter.call(p.children,function(x){return els.indexOf(x)>=0}),k=sib.indexOf(e);
e.classList.add("hbrv");if(e.matches(".ph,.vis"))e.classList.add(k%2?"hbr":"hbl");else if(e.matches(".h2,h2"))e.classList.add("hbz");
e.style.setProperty("--d",(Math.min(k,5)*.08)+"s");io.observe(e)});
/* count-up for plain numbers like 1,280円 / 15回 / 93件 */
var cn=[].slice.call(document.querySelectorAll("b,strong,.num,.big,.pr b,.price")).filter(function(e){return e.children.length==0&&/^[¥]?\d{1,3}(,\d{3})*(\.\d+)?$|^\d+$/.test(e.textContent.trim())&&!e.closest(".hbh,.hbf,svg,.sim,.res,form,[data-live],#sim")&&e.getBoundingClientRect().top>innerHeight*.9});
var io2=new IntersectionObserver(function(es){es.forEach(function(e){if(!e.isIntersecting)return;io2.unobserve(e.target);var t=e.target,raw=t.textContent.trim(),pre=raw[0]=="¥"?"¥":"",n=parseFloat(raw.replace(/[¥,]/g,"")),dec=(raw.split(".")[1]||"").length,com=raw.indexOf(",")>=0,t0=null;if(!(n>0))return;t.classList.add("hbcnt");
function f(v){var s=v.toFixed(dec);if(com)s=s.replace(/\B(?=(\d{3})+(?!\d))/g,",");return pre+s}
function st(ts){if(!t0)t0=ts;var q=Math.min(1,(ts-t0)/1100),ez=1-Math.pow(1-q,3);t.textContent=f(n*ez);if(q<1)requestAnimationFrame(st);else t.textContent=raw}requestAnimationFrame(st)})},{threshold:.6});
cn.forEach(function(e){io2.observe(e)});
})})();
/* ---------- 文の区切り：広い画面では「。」のあとで改行し、文の途中ではなるべく折り返さない（スマホはふつうに流す） ---------- */
(function(){
  function run(){
    var ps=document.querySelectorAll('main p, main figcaption, main .dgl');
    ps.forEach(function(p){
      if(p.closest('.cw,.hbh,.hbf,.fv,table,button,a,.chips')||p.querySelector('.sbr'))return;
      var t=p.textContent; if(t.length>260)return;
      var n=(t.match(/。(?![」』）)\s]*$)/g)||[]).length; if(!n||n>4)return;
      var w=document.createTreeWalker(p,NodeFilter.SHOW_TEXT,null),nodes=[],x;while((x=w.nextNode()))nodes.push(x);
      nodes.forEach(function(nd){
        var v=nd.nodeValue,i;if(v.indexOf('。')<0)return;
        var parts=v.split(/(?<=。)(?![」』）])/);
        var f=document.createDocumentFragment();
        parts.forEach(function(s){f.appendChild(document.createTextNode(s));if(/。$/.test(s)){var b=document.createElement('br');b.className='sbr';f.appendChild(b)}});
        nd.parentNode.replaceChild(f,nd);
      });
      /* 最後の「。」のうしろに何もなければ、そこには改行を入れない */
      var last=p.querySelectorAll('.sbr');if(last.length){var l=last[last.length-1],r=document.createRange();r.setStartAfter(l);r.setEndAfter(p.lastChild);if(!r.toString().trim())l.remove()}
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run);else run();
})();
/* 右上のボタンはひとつ：ログインしていない人には「ログイン」、している人には「Myハタボ」 */
(function(){try{var out=/[?&]out=1/.test(location.search);if(out){localStorage.removeItem('hbIn');history.replaceState(null,'',location.pathname)}var a=document.querySelectorAll('.hbh a.my[data-myacct]'),on=!!localStorage.getItem('hbIn');a.forEach(function(x){var l=x.querySelector('.myl');if(on){x.href='mypage.html';if(l)l.textContent='Myハタボ'}else{x.href='login.html';if(l)l.textContent='ログイン'}});document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('a[href^="https://app.hatha-lab.com"],a[href*="liff.line.me"]');if(b)try{localStorage.setItem('hbIn','1')}catch(_){}} ,true);if(/mypage\.html$/.test(location.pathname)&&document.referrer.indexOf('app.hatha-lab.com')>=0&&!out)localStorage.setItem('hbIn','1')}catch(e){}})();

/* 画面紹介：見えたら入ってきて、文字が流れるように出る（一度だけ） */
(function(){var L=document.querySelectorAll('.uiduo,.ui4');if(!L.length)return;L.forEach(function(e){e.classList.add('uianim')});
function go(e){if(e.classList.contains('on'))return;e.classList.add('on');if(e.classList.contains('uiduo')){e.classList.add('speak');setTimeout(function(){e.classList.remove('speak')},3800)}}
if(!('IntersectionObserver' in window)){L.forEach(go);return}var io=new IntersectionObserver(function(es){es.forEach(function(x){if(x.isIntersecting){go(x.target);io.unobserve(x.target)}})},{threshold:.28});L.forEach(function(e){io.observe(e)})})();
