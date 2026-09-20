const $=id=>document.getElementById(id);
let rows=[],autoPayload=null,dataSource="AUTO",activeSymbol=localStorage.getItem("kronos-symbol")||"RELIANCE.NS";

$("symbolInput").value=activeSymbol;
$("csv").addEventListener("change",e=>readCSV(e.target.files[0]));
$("shot").addEventListener("change",e=>showScreenshot(e.target.files[0]));
$("horizon").addEventListener("change",()=>{if(rows.length)render();});
$("range").addEventListener("change",()=>{if(rows.length)render();});
$("symbolInput").addEventListener("keydown",e=>{if(e.key==="Enter")loadMarket();
setInterval(() => { if (!document.hidden && !document.body.classList.contains("custom-mode")) loadMarket(true); }, LIVE_REFRESH_MS);});
["dragenter","dragover"].forEach(x=>$("drop").addEventListener(x,e=>{e.preventDefault();$("drop").classList.add("drag");}));
["dragleave","drop"].forEach(x=>$("drop").addEventListener(x,e=>{e.preventDefault();$("drop").classList.remove("drag");}));
$("drop").addEventListener("drop",e=>readCSV(e.dataTransfer.files[0]));

function setStatus(t,ok=true){$("statusText").textContent=t;$("statusDot").classList.toggle("bad",!ok);}
function setBusy(v){$("refreshBtn").disabled=v;$("refreshBtn").textContent=v?"Loading…":"Refresh";}
function fmt(n){return Number(n).toLocaleString(undefined,{maximumFractionDigits:2});}

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
   rows=item.history.map(x=>({date:x.date,close:+x.close}));
   render();setStatus("KRONOS READY • "+item.last_date,true);
 }catch(e){
   setStatus("TICKER NOT AVAILABLE",false);
   $("signalText").textContent="This ticker is not in the current automatic generated universe. Upload a CSV for custom history or choose a Quick Access market.";
 }finally{setBusy(false);}
}

function render(){
 const s=activeSymbol,item=autoPayload?.symbols?.[s],n=+$("horizon").value,range=+$("range").value;
 $("symbol").textContent=(dataSource==="CSV"?"CUSTOM • ":"")+s+" • 1D";
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
function draw(hist,pred){
 const c=$("chart"),x=c.getContext("2d"),dpr=devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;
 c.width=w*dpr;c.height=h*dpr;x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,w,h);
 const hv=hist.map(v=>+v.close),pv=pred.map(v=>+v.close),all=hv.concat(pv),mn=Math.min(...all),mx=Math.max(...all),pad=32;
 const X=i=>pad+i*(w-pad*2)/Math.max(1,all.length-1),Y=v=>h-pad-(v-mn)/(mx-mn||1)*(h-pad*2);
 x.strokeStyle="#202733";x.lineWidth=1;
 for(let i=0;i<5;i++){let yy=pad+i*(h-pad*2)/4;x.beginPath();x.moveTo(pad,yy);x.lineTo(w-pad,yy);x.stroke();}
 x.strokeStyle="#e9edf3";x.lineWidth=2;x.beginPath();hv.forEach((v,i)=>i?x.lineTo(X(i),Y(v)):x.moveTo(X(i),Y(v)));x.stroke();
 if(pv.length){x.strokeStyle="#a9ff6b";x.lineWidth=2;x.setLineDash([5,5]);x.beginPath();x.moveTo(X(hv.length-1),Y(hv.at(-1)));pv.forEach((v,j)=>x.lineTo(X(hv.length+j),Y(v)));x.stroke();x.setLineDash([]);}
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
