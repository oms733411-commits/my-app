const $=id=>document.getElementById(id);
let rows=[],autoPayload=null,dataSource="AUTO",activeSymbol=localStorage.getItem("kronos-symbol")||"RELIANCE.NS";
const LIVE_REFRESH_MS=15000;
let liveQuote=null,btcSocket=null;

$("symbolInput").value=activeSymbol;
$("csv").addEventListener("change",e=>readCSV(e.target.files[0]));
$("shot").addEventListener("change",e=>showScreenshot(e.target.files[0]));
$("horizon").addEventListener("change",()=>{if(rows.length)render();});
$("range").addEventListener("change",()=>{if(rows.length)render();});
$("chartType").addEventListener("change",()=>{if(rows.length)render();});
$("chart").addEventListener("mousemove",chartHover);
$("chart").addEventListener("mouseleave",()=>$("chartTip").classList.add("hidden"));
$("symbolInput").addEventListener("keydown",e=>{if(e.key==="Enter")loadMarket();});
setInterval(()=>{if(!document.hidden && dataSource==="AUTO") refreshLiveQuote();},LIVE_REFRESH_MS);
window.addEventListener("beforeunload",()=>{if(btcSocket)btcSocket.close();});
["dragenter","dragover"].forEach(x=>$("drop").addEventListener(x,e=>{e.preventDefault();$("drop").classList.add("drag");}));
["dragleave","drop"].forEach(x=>$("drop").addEventListener(x,e=>{e.preventDefault();$("drop").classList.remove("drag");}));
$("drop").addEventListener("drop",e=>readCSV(e.dataTransfer.files[0]));

function setStatus(t,ok=true){$("statusText").textContent=t;$("statusDot").classList.toggle("bad",!ok);}
function setBusy(v){$("refreshBtn").disabled=v;$("refreshBtn").textContent=v?"Loading…":"Refresh";}
function fmt(n){return Number(n).toLocaleString(undefined,{maximumFractionDigits:2});}
async function fetchLiveQuote(symbol){
  if(symbol==="BTC-USD"){
    return await new Promise((resolve,reject)=>{
      if(btcSocket) try{btcSocket.close();}catch{}
      const ws=new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@ticker");
      btcSocket=ws; let done=false;
      const finish=(v,err)=>{if(done)return;done=true;try{ws.close();}catch{};err?reject(err):resolve(v);};
      ws.onmessage=e=>{try{const d=JSON.parse(e.data);finish({price:+d.c,change:+d.P,source:"Binance live",time:new Date(+d.E)});}catch(err){finish(null,err);}};
      ws.onerror=()=>finish(null,Error("BTC live stream unavailable"));
      setTimeout(()=>finish(null,Error("BTC live stream timeout")),5000);
    });
  }
  const url="https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(symbol)+"?interval=1m&range=1d";
  const r=await fetch(url,{cache:"no-store"});
  if(!r.ok)throw Error("live quote unavailable");
  const j=await r.json(),m=j.chart?.result?.[0]?.meta||{};
  const price=Number(m.regularMarketPrice ?? m.previousClose);
  if(!Number.isFinite(price))throw Error("no live price");
  const change=Number(m.regularMarketChangePercent);
  return {price,change:Number.isFinite(change)?change:null,source:"Yahoo Finance quote",time:m.regularMarketTime?new Date(m.regularMarketTime*1000):new Date()};
}
async function refreshLiveQuote(){
  if(dataSource!=="AUTO"||!activeSymbol)return;
  try{
    liveQuote=await fetchLiveQuote(activeSymbol);
    if(!liveQuote||!Number.isFinite(liveQuote.price))return;
    $("last").textContent=fmt(liveQuote.price);
    $("lastMini").textContent=fmt(liveQuote.price);
    $("lastDate").textContent="LIVE QUOTE • "+liveQuote.time.toLocaleTimeString();
    $("dataMini").textContent="LIVE";
    $("updatedMini").textContent=liveQuote.source;
    const item=autoPayload?.symbols?.[activeSymbol];
    const n=+$("horizon").value;
    const pred=item?.forecast?.[String(n)]||[];
    const end=pred.at(-1)?.close;
    if(Number.isFinite(end)){
      const pct=(end/liveQuote.price-1)*100;
      $("forecastPct").textContent=(pct>=0?"+":"")+pct.toFixed(2)+"% from live price";
      $("confidenceMini").textContent="Live price basis";
    }
    const range=+( $("range")?.value || 252 );
    const itemRows=(autoPayload?.symbols?.[activeSymbol]?.history||rows).slice(-Math.min(range,rows.length));
    const forecast=autoPayload?.symbols?.[activeSymbol]?.forecast?.[String(+$("horizon").value)]||[];
    draw(itemRows,forecast);
  }catch(e){
    $("dataMini").textContent="AUTO";
  }
}

async function loadPayload(){
 const r=await fetch("data/market.json?"+Date.now(),{cache:"no-store"});
 if(!r.ok)throw Error("market dataset unavailable");
 return await r.json();
}
async function loadMarket(){
 const s=$("symbolInput").value.trim().toUpperCase();if(!s)return;
 activeSymbol=s;localStorage.setItem("kronos-symbol",s);dataSource="AUTO";setBusy(true);setStatus("LOADING KRONOS DATA");
 try{
   autoPayload=await loadPayload();
   const item=autoPayload.symbols?.[s];
   if(!item)throw Error("Ticker not in generated universe");
   rows=item.history.map(x=>({date:x.date,open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+(x.volume||0)}));
   render();setStatus("KRONOS READY • "+item.last_date,true);refreshLiveQuote();
 }catch(e){
   setStatus("TICKER NOT AVAILABLE",false);
   $("signalText").textContent="This ticker is not in the current automatic generated universe. Upload a CSV for custom history or choose a Quick Access market.";
 }finally{setBusy(false);}
}

function render(){
 const s=activeSymbol,item=autoPayload?.symbols?.[s],n=+$("horizon").value,range=+$("range").value;
 $("symbol").textContent=(dataSource==="CSV"?"CUSTOM • ":"")+s+" • DAILY";
 const hist=rows.slice(-Math.min(range,rows.length)),last=hist.at(-1).close;
 $("last").textContent=fmt(last);$("lastMini").textContent=fmt(last);$("lastDate").textContent="Latest available • "+(item?.last_date||hist.at(-1).date);
 $("horizonOut").textContent=n+" sessions";
 $("dataMini").textContent=dataSource==="AUTO"?"AUTO":"CSV";
 $("updatedMini").textContent=autoPayload?.generated_at?new Date(autoPayload.generated_at).toLocaleString():"Local";
 $("dataMode").textContent=dataSource==="AUTO"?"Automatic":"Custom CSV";
 $("dataSource").textContent=dataSource==="AUTO"?"Latest generated OHLCV dataset.":"User-selected file; it remains local to this browser.";
 if(dataSource==="AUTO"&&item){
   const pred=item.forecast[String(n)]||[],end=pred.at(-1)?.close||last;
   const pct=(end/last-1)*100,dir=pct>=0?"UP":"DOWN";
   $("direction").textContent=dir;$("directionMini").textContent=dir;
   $("direction").style.color=dir==="UP"?"#a9ff6b":"#ff8f8f";$("directionMini").style.color=dir==="UP"?"#a9ff6b":"#ff8f8f";
   $("confidence").textContent="Model direction";$("confidenceMini").textContent=(pct>=0?"+":"")+pct.toFixed(2)+"% projected";
   $("forecastMini").textContent=fmt(end);$("forecastPct").textContent=(pct>=0?"+":"")+pct.toFixed(2)+"%";
   $("end").textContent=fmt(end);
   $("signalText").textContent="Original Kronos-small forecast generated from the latest automatic OHLCV history.";
   draw(hist,pred);
   renderBacktest(item.backtest);
 }else{
   $("direction").textContent="—";$("directionMini").textContent="CUSTOM";
   $("confidence").textContent="Kronos runtime not in browser";
   $("forecastMini").textContent="—";$("forecastPct").textContent="Custom data loaded";
   $("end").textContent="—";
   $("signalText").textContent="Custom CSV is loaded locally. Automatic Kronos forecasts use the generated market universe; custom CSV inference requires a model runtime.";
   draw(hist,[]);
   clearBacktest("Custom CSV loaded. Automatic model backtests are kept separate from custom browser data.");
 }
}
let chartState={hist:[],pred:[],live:null,mn:0,mx:1,pad:44,w:0,h:0,total:0};
function draw(hist,pred){
 const c=$("chart"),x=c.getContext("2d"),dpr=devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;
 c.width=w*dpr;c.height=h*dpr;x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,w,h);
 const live=liveQuote?.price, all=hist.concat(pred.map(v=>({date:v.date,close:+v.close}))), vals=hist.flatMap(v=>[v.low??v.close,v.high??v.close]).concat(pred.map(v=>+v.close));
 if(Number.isFinite(live))vals.push(live); let mn=Math.min(...vals),mx=Math.max(...vals),pad=42; const span=mx-mn||1; mn-=span*.06;mx+=span*.06;
 chartState={hist,pred,live,mn,mx,pad,w,h,total:all.length};
 const X=i=>pad+i*(w-pad*2)/Math.max(1,all.length-1),Y=v=>h-pad-(v-mn)/(mx-mn)*(h-pad*2);
 x.fillStyle="#0b0f15";x.fillRect(0,0,w,h); x.font="10px Inter, sans-serif";
 x.strokeStyle="#202733";x.lineWidth=1;
 for(let i=0;i<5;i++){const yy=pad+i*(h-pad*2)/4;x.beginPath();x.moveTo(pad,yy);x.lineTo(w-pad,yy);x.stroke();const val=mx-(mx-mn)*i/4;x.fillStyle="#778296";x.fillText(fmt(val),6,yy+3);}
 const ticks=Math.min(6,hist.length); for(let k=0;k<ticks;k++){const idx=Math.round(k*(hist.length-1)/Math.max(1,ticks-1));const xx=X(idx);x.fillStyle="#778296";x.fillText(shortDate(hist[idx]?.date),Math.max(pad,xx-20),h-10);}
 const type=$("chartType").value;
 if(type==="candles"){
   const step=(w-pad*2)/Math.max(1,all.length-1),cw=Math.max(2,Math.min(12,step*.62));
   hist.forEach((v,i)=>{const o=+v.open||+v.close,hi=+v.high||+v.close,lo=+v.low||+v.close,cl=+v.close;const up=cl>=o; x.strokeStyle=up?"#79e38b":"#ff7f7f";x.fillStyle=up?"#79e38b":"#ff7f7f";x.lineWidth=1;x.beginPath();x.moveTo(X(i),Y(hi));x.lineTo(X(i),Y(lo));x.stroke();const top=Y(Math.max(o,cl)),bot=Y(Math.min(o,cl));x.fillRect(X(i)-cw/2,top,cw,Math.max(1,bot-top));});
 }else{
   x.strokeStyle="#e9edf3";x.lineWidth=2;x.beginPath();hist.forEach((v,i)=>i?x.lineTo(X(i),Y(+v.close)):x.moveTo(X(i),Y(+v.close)));x.stroke();
   if(type==="area"){x.lineTo(X(hist.length-1),h-pad);x.lineTo(X(0),h-pad);x.closePath();x.globalAlpha=.10;x.fillStyle="#e9edf3";x.fill();x.globalAlpha=1;}
 }
 if(pred.length){x.strokeStyle="#a9ff6b";x.lineWidth=2;x.setLineDash([6,5]);x.beginPath();x.moveTo(X(hist.length-1),Y(hist.at(-1).close));pred.forEach((v,j)=>x.lineTo(X(hist.length+j),Y(+v.close)));x.stroke();x.setLineDash([]);}
 if(Number.isFinite(live)){const lx=X(Math.max(0,hist.length-1)),ly=Y(live);x.strokeStyle="#5bd6ff";x.lineWidth=1;x.setLineDash([3,3]);x.beginPath();x.moveTo(pad,ly);x.lineTo(w-pad,ly);x.stroke();x.setLineDash([]);x.fillStyle="#5bd6ff";x.beginPath();x.arc(lx,ly,4,0,Math.PI*2);x.fill();x.fillText("LIVE",w-pad-30,ly-7);}
}
function shortDate(s){const d=new Date(s+"T00:00:00");return Number.isNaN(d.getTime())?s.slice(0,10):d.toLocaleDateString(undefined,{day:"2-digit",month:"short"});}
function chartHover(e){
 if(!chartState.hist.length)return; const c=$("chart"),r=c.getBoundingClientRect(),px=e.clientX-r.left,pad=chartState.pad,step=(chartState.w-pad*2)/Math.max(1,chartState.total-1);let i=Math.round((px-pad)/step);i=Math.max(0,Math.min(chartState.hist.length-1,i));const v=chartState.hist[i];if(!v)return;
 const tip=$("chartTip");tip.classList.remove("hidden");tip.innerHTML='<b>'+v.date+'</b><span>O '+fmt(v.open)+' · H '+fmt(v.high)+' · L '+fmt(v.low)+' · C '+fmt(v.close)+'</span><span>Volume '+Number(v.volume||0).toLocaleString()+'</span>';tip.style.left=Math.min(Math.max(px+12,8),c.clientWidth-205)+"px";tip.style.top=Math.max(8,e.clientY-r.top-58)+"px";
}
function renderBacktest(bt){
 if(!bt)return clearBacktest("No rolling backtest is available for this symbol yet.");
 $("mae").textContent=fmt(bt.mae);$("rmse").textContent=fmt(bt.rmse);$("dir").textContent=Math.round(bt.direction)+"%";
 $("btWindows").textContent=bt.windows+" windows • "+bt.horizon+"D";
 $("dirBar").style.width=Math.min(100,Math.max(0,bt.direction))+"%";
 const last=rows.at(-1)?.close||1;
 $("maeBar").style.width=Math.min(100,Math.max(6,100/(1+bt.mae/last*20)))+"%";
 $("rmseBar").style.width=Math.min(100,Math.max(6,100/(1+bt.rmse/last*20)))+"%";
 $("backtestNote").textContent="Out-of-sample rolling test: each prediction window uses only history available before that window. Metrics are generated with the original Kronos-small model.";
}
function clearBacktest(note){["mae","rmse","dir"].forEach(id=>$(id).textContent="—");$("btWindows").textContent="—";$("maeBar").style.width="0%";$("rmseBar").style.width="0%";$("dirBar").style.width="0%";$("backtestNote").textContent=note;}

function readCSV(file){
 if(!file)return;if(!file.name.toLowerCase().endsWith(".csv"))return alert("Please choose a CSV file.");
 const r=new FileReader();r.onload=()=>{try{
  const d=parseCSV(r.result);if(d.length<60)throw Error("Need at least 60 valid rows.");
  rows=d;dataSource="CSV";autoPayload=null;activeSymbol="CUSTOM";$("symbolInput").value="CUSTOM";render();setStatus("CSV LOADED • LOCAL");
 }catch(e){alert("CSV needs timestamp/date + open + high + low + close. Volume is recommended.");}};
 r.readAsText(file);
}
function parseCSV(t){
 const lines=t.trim().split(/\r?\n/).filter(Boolean),h=lines.shift().split(",").map(v=>v.trim().toLowerCase().replace(/["']/g,""));
 const find=names=>{for(const n of names){const i=h.findIndex(v=>v===n||v.includes(n));if(i>=0)return i;}return-1};
 const ti=find(["timestamp","datetime","date","time"]),oi=find(["open"]),hi=find(["high"]),li=find(["low"]),ci=find(["close"]),vi=find(["volume"]);
 if(Math.min(ti,oi,hi,li,ci)<0)throw Error();
 return lines.map(l=>{const a=l.split(",");return{date:a[ti],open:+a[oi],high:+a[hi],low:+a[li],close:+a[ci],volume:vi>=0?+a[vi]:0};}).filter(x=>x.date&&[x.open,x.high,x.low,x.close].every(Number.isFinite));
}
function showScreenshot(file){
 if(!file)return;const box=$("shotPreview"),url=URL.createObjectURL(file);box.classList.remove("hidden");box.innerHTML='<img alt="Uploaded chart screenshot" src="'+url+'"><span>Screenshot attached locally</span>';
}
function buildChips(){
 const wrap=$("symbolChips");wrap.innerHTML="";
 const list=["RELIANCE.NS","TCS.NS","INFY.NS","HDFCBANK.NS","ICICIBANK.NS","SBIN.NS","BHARTIARTL.NS","ITC.NS","LT.NS","HINDUNILVR.NS","KOTAKBANK.NS","AXISBANK.NS","MARUTI.NS","SUNPHARMA.NS","TATAMOTORS.NS","IDEA.NS","AAPL","MSFT","GOOGL","AMZN","NVDA","TSLA","META","NFLX","AMD","BTC-USD","ETH-USD","GC=F","XAUUSD=X"];
 list.forEach(s=>{const b=document.createElement("button");b.className="chip";b.textContent=s;b.onclick=()=>{$("symbolInput").value=s;loadMarket();};wrap.appendChild(b);});
}
window.addEventListener("resize",()=>{if(rows.length)render();});
(async()=>{buildChips();try{await loadMarket();}catch(e){setStatus("READY • SELECT A MARKET");}})();
