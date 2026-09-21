const $=id=>document.getElementById(id);
let rows=[],autoPayload=null,dataSource="AUTO",activeSymbol=localStorage.getItem("kronos-symbol")||"RELIANCE.NS";
const LIVE_REFRESH_MS=15000;
const MARKET_REFRESH_MS=600000; // refresh the generated market/Kronos dataset every 10 minutes
let lastMarketSyncAt=0,marketRefreshBusy=false;
let liveQuote=null,btcSocket=null;

$("symbolInput").value=activeSymbol;
$("csv").addEventListener("change",e=>readCSV(e.target.files[0]));
$("shot").addEventListener("change",e=>showScreenshot(e.target.files[0]));
$("horizon").addEventListener("change",()=>{if(rows.length)render();});
$("range").addEventListener("change",()=>{if(($("interval")?.value||"1d")!=="1d"){ $("intradayRange").value=$("range").value; loadChartMode(); } else if(rows.length)render();});
$("interval").addEventListener("change",()=>{syncTimeframeButtons();loadChartMode();});
$("intradayRange").addEventListener("change",()=>loadChartMode());
function syncTimeframeButtons(){
  const mode=$("interval")?.value||"1d";
  document.querySelectorAll(".tf-btn").forEach(b=>b.classList.toggle("active",b.dataset.tf===mode));
  document.body.classList.toggle("intraday-mode",mode!=="1d");
  const range=$("range");
  if(!range)return;
  const isIntraday=mode!=="1d";
  const values=isIntraday?["1d","5d","1mo"]:["5","22","66","132","252","400"];
  const labels=isIntraday?["1D","5D","1M"]:["1W","1M","3M","6M","1Y","Max"];
  const current=isIntraday?($("intradayRange")?.value||"1d"):(range.value||"252");
  range.innerHTML=values.map((v,i)=>'<option value="'+v+'">'+labels[i]+'</option>').join("");
  range.value=values.includes(current)?current:values[isIntraday?0:4];
  range.setAttribute("aria-label",isIntraday?"Intraday chart range":"Daily chart range");
  if($("intradayRange"))$("intradayRange").value=range.value;
}
document.querySelectorAll(".tf-btn").forEach(b=>b.addEventListener("click",()=>{
  const mode=b.dataset.tf||"1d";
  $("interval").value=mode;
  syncTimeframeButtons();
  loadChartMode();
}));
syncTimeframeButtons();
$("chartType").addEventListener("change",()=>{if(rows.length)render();});
$("chart").addEventListener("mousemove",chartHover);
$("chart").addEventListener("mouseleave",()=>{chartState.hoverIndex=-1; $("chartTip").classList.add("hidden"); renderChartOnly();});
$("chart").addEventListener("pointermove",chartHover,{passive:true});
$("chart").addEventListener("pointerleave",()=>{chartState.hoverIndex=-1; $("chartTip").classList.add("hidden"); renderChartOnly();});
$("chart").addEventListener("wheel",chartWheel,{passive:false});
$("symbolInput").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();loadMarket();}});
setInterval(()=>{if(!document.hidden && dataSource==="AUTO") refreshLiveQuote();},LIVE_REFRESH_MS);
setInterval(()=>{if(!document.hidden && dataSource==="AUTO") refreshMarketData();},MARKET_REFRESH_MS);
window.addEventListener("beforeunload",()=>{if(btcSocket)btcSocket.close();});
["dragenter","dragover"].forEach(x=>$("drop").addEventListener(x,e=>{e.preventDefault();$("drop").classList.add("drag");}));
["dragleave","drop"].forEach(x=>$("drop").addEventListener(x,e=>{e.preventDefault();$("drop").classList.remove("drag");}));
$("drop").addEventListener("drop",e=>readCSV(e.dataTransfer.files[0]));

function setStatus(t,ok=true){$("statusText").textContent=t;$("statusDot").classList.toggle("bad",!ok);}
function setBusy(v){$("refreshBtn").disabled=v;$("refreshBtn").textContent=v?"Loading…":"Refresh";}
function fmt(n){const x=Number(n);return Number.isFinite(x)?x.toLocaleString(undefined,{maximumFractionDigits:2}):"—";}
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
  const token=++liveQuoteToken;
  const symbolAtStart=activeSymbol;
  if(dataSource!=="AUTO"||!symbolAtStart)return;
  try{
    const quote=await fetchLiveQuote(symbolAtStart);
    if(token!==liveQuoteToken||symbolAtStart!==activeSymbol||dataSource!=="AUTO")return;
    liveQuote=quote;
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
    if(($("interval")?.value||"1d")!=="1d") return;
    const range=+( $("range")?.value || 252 );
    const itemRows=(autoPayload?.symbols?.[activeSymbol]?.history||rows).slice(-Math.min(range,rows.length));
    const forecast=autoPayload?.symbols?.[activeSymbol]?.forecast?.[String(+$("horizon").value)]||[];
    draw(itemRows,forecast);
  }catch(e){
    $("dataMini").textContent="AUTO";
  }
}

async function loadPayload(){
 const stamp=Date.now();
 const sources=[
   "https://raw.githubusercontent.com/oms733411-commits/my-app/main/web/data/market.json?ts="+stamp,
   "data/market.json?ts="+stamp
 ];
 let lastError=null;
 for(const url of sources){
   try{
     const r=await fetch(url,{cache:"no-store"});
     if(!r.ok)throw Error("HTTP "+r.status);
     const data=await r.json();
     if(data?.symbols && typeof data.symbols==="object")return data;
   }catch(e){lastError=e;}
 }
 throw lastError||Error("market dataset unavailable");
}
async function refreshMarketData(){
 if(marketRefreshBusy||dataSource!=="AUTO")return;
 marketRefreshBusy=true;
 const symbolAtStart=activeSymbol;
 const modeAtStart=$("interval")?.value||"1d";
 const rangeAtStart=$("range")?.value||"252";
 const intraRangeAtStart=$("intradayRange")?.value||"1d";
 try{
   const fresh=await loadPayload();
   if(dataSource!=="AUTO"||activeSymbol!==symbolAtStart)return;
   const item=fresh.symbols?.[symbolAtStart];
   if(!item)throw Error("Ticker not in refreshed dataset");
   autoPayload=fresh;
   rows=normalizeChartRows(item.history);
   lastMarketSyncAt=Date.now();
   if(modeAtStart==="1d"){
     $("interval").value="1d";
     $("range").value=rangeAtStart;
     syncTimeframeButtons();
     render();
   }else{
     $("interval").value=modeAtStart;
     syncTimeframeButtons();
     $("intradayRange").value=intraRangeAtStart;
     await loadChartMode();
   }
   if(dataSource==="AUTO"&&activeSymbol===symbolAtStart){
     setStatus("AUTO-REFRESHED • "+(item.last_date||"latest"),true);
     refreshLiveQuote();
   }
 }catch(e){
   console.warn("10-minute market refresh failed",e);
 }finally{
   marketRefreshBusy=false;
 }
}
let chartLoadToken=0, marketLoadToken=0, liveQuoteToken=0, marketAbort=null, intradayAbort=null;
async function loadChartMode(){
  const token=++chartLoadToken;
  if(intradayAbort) try{intradayAbort.abort();}catch{}
  intradayAbort=new AbortController();
  const signal=intradayAbort.signal;
  const mode=$("interval")?.value||"1d";
  syncTimeframeButtons();
  if(mode==="1d"){
    chartState.intraday=false;
    render();
    syncTimeframeButtons();
    return;
  }
  const range=$("intradayRange")?.value||"1d";
  setStatus("LOADING "+mode.toUpperCase()+" INTRADAY");
  try{
    const symbolAtStart=activeSymbol;
    const allIntraday=await fetchIntraday(symbolAtStart,mode,range,signal);
    if(token!==chartLoadToken||symbolAtStart!==activeSymbol||signal.aborted)return;
    if(!allIntraday.length)throw Error("No intraday data");
    const barsPerDay={"5m":78,"15m":26,"1h":7};
    const requestedDays=range==="1d"?1:range==="5d"?5:22;
    const intraday=allIntraday.slice(-(barsPerDay[mode]||78)*requestedDays);
    chartState.intraday=true;
    const intradayPack=autoPayload?.symbols?.[symbolAtStart]?.intraday?.[mode];
    if(token!==chartLoadToken)return;
    const pred=normalizeForecast(intradayPack?.forecast||[]);
    // The chart must remain usable even while the scheduled Kronos dataset is regenerating.
    // Show the latest real intraday candles first; add Kronos as soon as its generated forecast arrives.
    const last=intraday.at(-1).close;
    const end=pred.at(-1)?.close;
    const pct=Number.isFinite(end)&&Number.isFinite(last)?(end/last-1)*100:null;
    const dir=pct===null?"—":pct>=0?"UP":"DOWN";
    draw(intraday,pred);
    $("symbol").textContent=activeSymbol+" • "+mode.toUpperCase()+" • KRONOS";
    $("chartHint").textContent="White = actual candles • Green dashed = original Kronos forecast";
    $("last").textContent=fmt(last);
    $("lastMini").textContent=fmt(last);
    $("lastDate").textContent="LIVE INTRADAY • "+new Date(intraday.at(-1).date).toLocaleString();
    $("dataMini").textContent="LIVE";
    $("updatedMini").textContent=intradayPack?.generated_at
      ? "Kronos updated "+new Date(intradayPack.generated_at).toLocaleString()
      : "Free intraday feed";
    $("horizonOut").textContent=pred.length?pred.length+" "+mode+" bars":"—";
    $("forecastMini").textContent=Number.isFinite(end)?fmt(end):"—";
    $("forecastPct").textContent=Number.isFinite(pct)?(pct>=0?"+":"")+pct.toFixed(2)+"% projected":"Preparing…";
    $("end").textContent=Number.isFinite(end)?fmt(end):"—";
    $("signalText").textContent=pred.length
      ? "Original Kronos-small intraday forecast from the latest generated OHLCV context. Live candles are fetched separately."
      : "Live/latest intraday candles are shown now. The scheduled original Kronos forecast will appear automatically when the next market dataset is published.";
    $("confidence").textContent=pred.length?"Kronos intraday model":"Intraday view";
    $("confidenceMini").textContent=pred.length?(pct>=0?"+":"")+pct.toFixed(2)+"% projected":mode.toUpperCase()+" candles";
    $("direction").textContent=dir; $("directionMini").textContent=dir;
    $("direction").style.color=dir==="UP"?"#a9ff6b":dir==="DOWN"?"#ff8f8f":"";
    $("directionMini").style.color=dir==="UP"?"#a9ff6b":dir==="DOWN"?"#ff8f8f":"";
    clearBacktest("Intraday mode uses the latest intraday feed. Daily rolling backtest metrics are shown only in daily mode.");
    setStatus(pred.length?"INTRADAY + KRONOS READY":"INTRADAY READY • KRONOS UPDATING",true);
  }catch(e){
    if(token!==chartLoadToken)return;
    console.error("Intraday load failed",e);
    chartState.intraday=false;
    setStatus("INTRADAY ERROR • "+(e?.message||"FEED UNAVAILABLE"),false);
  }
}
async function fetchIntraday(symbol,interval,range,signal){
  // Prefer the generated GitHub dataset. This avoids browser CORS/provider failures.
  const pack=autoPayload?.symbols?.[symbol]?.intraday?.[interval];
  if(Array.isArray(pack?.history) && pack.history.length){
    return normalizeChartRows(pack.history).slice(-1000);
  }

  if((symbol==="BTC-USD"||symbol==="ETH-USD")&&window.fetch){
    const map={ "5m":"5m","15m":"15m","1h":"1h" };
    const bin= symbol==="BTC-USD"?"BTCUSDT":"ETHUSDT";
    const limit=range==="1d"?288:range==="5d"?1000:1000;
    const r=await fetch("https://api.binance.com/api/v3/klines?symbol="+bin+"&interval="+map[interval]+"&limit="+limit,{cache:"no-store",signal});
    if(r.ok){
      const a=await r.json();
      return a.map(v=>({date:new Date(+v[0]).toISOString(),open:+v[1],high:+v[2],low:+v[3],close:+v[4],volume:+v[5]})).filter(v=>[v.open,v.high,v.low,v.close].every(Number.isFinite));
    }
  }
  const url="https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(symbol)+"?interval="+encodeURIComponent(interval)+"&range="+encodeURIComponent(range);
  const r=await fetch(url,{cache:"no-store",signal}); if(!r.ok)throw Error("intraday unavailable");
  const j=await r.json(),res=j.chart?.result?.[0]; if(!res)throw Error("no intraday result");
  const q=res.indicators?.quote?.[0]||{},ts=res.timestamp||[];
  return ts.map((t,i)=>({date:new Date(t*1000).toISOString(),open:+q.open?.[i],high:+q.high?.[i],low:+q.low?.[i],close:+q.close?.[i],volume:+q.volume?.[i]||0}))
    .filter(v=>v.date&&[v.open,v.high,v.low,v.close].every(Number.isFinite));
}
async function fetchDailyFallback(symbol){
  const url="https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(symbol)+"?interval=1d&range=2y";
  const r=await fetch(url,{cache:"no-store"});
  if(!r.ok)throw Error("daily market feed unavailable");
  const j=await r.json(),res=j.chart?.result?.[0];
  if(!res)throw Error("no daily market result");
  const q=res.indicators?.quote?.[0]||{},ts=res.timestamp||[];
  return ts.map((t,i)=>({date:new Date(t*1000).toISOString(),open:+q.open?.[i],high:+q.high?.[i],low:+q.low?.[i],close:+q.close?.[i],volume:+q.volume?.[i]||0}))
    .filter(v=>v.date&&[v.open,v.high,v.low,v.close].every(Number.isFinite));
}
async function loadMarket(){
 const s=$("symbolInput").value.trim().toUpperCase();if(!s)return;
 const token=++marketLoadToken;
 if(marketAbort) try{marketAbort.abort();}catch{}
 if(intradayAbort) try{intradayAbort.abort();}catch{}
 chartLoadToken++;
 liveQuoteToken++;
 marketAbort=new AbortController();
 activeSymbol=s;
 localStorage.setItem("kronos-symbol",s);
 dataSource="AUTO";
 liveQuote=null;
 $("last").textContent="—";$("lastMini").textContent="—";
 $("lastDate").textContent="Loading "+s+"…";
 $("dataMini").textContent="LOADING";
 $("updatedMini").textContent="—";
 setBusy(true);setStatus("LOADING "+s+" • MARKET DATA");
 try{
   autoPayload=await loadPayload();
   if(token!==marketLoadToken)return;
   const item=autoPayload.symbols?.[s];
   if(!item)throw Error("Ticker not in generated universe");
   rows=normalizeChartRows(item.history);
   if(!rows.length)throw Error("No market history");
   chartState.intraday=false;
   $("symbol").textContent=s+" • DAILY";
   render();
   if(token!==marketLoadToken)return;
   setStatus("MARKET READY • "+(item.last_date||"latest"),true);
   refreshLiveQuote();
 }catch(e){
   if(token!==marketLoadToken)return;
   if(e?.name==="AbortError")return;
   console.error("Market load failed",e);
   autoPayload=null;rows=[];
   setStatus("TICKER NOT AVAILABLE",false);
   $("symbol").textContent=s+" • UNAVAILABLE";
   $("signalText").textContent="No automatic dataset is available for this ticker yet. Choose a supported market or upload a CSV.";
 }finally{
   if(token===marketLoadToken)setBusy(false);
 }
}

function render(){
 const s=activeSymbol,item=autoPayload?.symbols?.[s],n=+$("horizon").value,range=+$("range").value;
 if(($("interval")?.value||"1d")!=="1d"){ loadChartMode(); return; }
 chartState.intraday=false;
 $("symbol").textContent=(dataSource==="CSV"?"CUSTOM • ":"")+s+" • DAILY";
 const hist=normalizeChartRows(rows).slice(-Math.min(range,rows.length));if(!hist.length){throw Error("No valid OHLC history");}const last=hist.at(-1).close;
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
   $("direction").textContent="—";$("directionMini").textContent=dataSource==="AUTO"?"UPDATING":"CUSTOM";
   $("confidence").textContent=dataSource==="AUTO"?"Kronos dataset updating":"Kronos runtime not in browser";
   $("forecastMini").textContent="—";$("forecastPct").textContent="Custom data loaded";
   $("end").textContent="—";
   $("signalText").textContent="Custom CSV is loaded locally. Automatic Kronos forecasts use the generated market universe; custom CSV inference requires a model runtime.";
   draw(hist,[]);
   clearBacktest("Custom CSV loaded. Automatic model backtests are kept separate from custom browser data.");
 }
}
let chartState={hist:[],pred:[],live:null,mn:0,mx:1,pad:44,w:0,h:0,total:0,hoverIndex:-1,intraday:false};
function normalizeChartRows(list){
  return (Array.isArray(list)?list:[]).map(v=>({
    date:String(v?.date||""),
    open:Number(v?.open),
    high:Number(v?.high),
    low:Number(v?.low),
    close:Number(v?.close),
    volume:Number(v?.volume||0)
  })).filter(v=>v.date&&Number.isFinite(v.close)&&Number.isFinite(v.high)&&Number.isFinite(v.low));
}
function normalizeForecast(list){
  return (Array.isArray(list)?list:[]).map(v=>({date:String(v?.date||""),close:Number(v?.close)}))
    .filter(v=>v.date&&Number.isFinite(v.close));
}
function renderChartOnly(){draw(chartState.hist,chartState.pred);}
function draw(hist,pred){
  const c=$("chart"),ctx=c.getContext("2d"),dpr=window.devicePixelRatio||1;
  const rect=c.getBoundingClientRect(),w=Math.max(320,Math.floor(rect.width||320)),h=Math.max(260,Math.floor(rect.height||300));
  c.width=Math.round(w*dpr);c.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  hist=normalizeChartRows(hist);pred=normalizeForecast(pred);
  const live=Number.isFinite(Number(liveQuote?.price))?Number(liveQuote.price):null;
  chartState.intraday = chartState.intraday || (hist.length && String(hist[0].date).includes("T"));
  const values=[];
  hist.forEach(v=>{[v.open,v.high,v.low,v.close].forEach(x=>{if(Number.isFinite(x))values.push(x);});});
  pred.forEach(v=>{if(Number.isFinite(v.close))values.push(v.close);});
  if(live!==null)values.push(live);
  let mn=values.length?Math.min(...values):0,mx=values.length?Math.max(...values):1;
  if(!Number.isFinite(mn)||!Number.isFinite(mx)){mn=0;mx=1;}
  let span=mx-mn;if(!Number.isFinite(span)||span<=0)span=Math.max(Math.abs(mx)*.01,1);
  mn-=span*.07;mx+=span*.07;
  const pad=48,volumeH=48,priceBottom=Math.max(pad+30,h-pad-volumeH);
  const total=Math.max(1,hist.length+pred.length),step=(w-pad*2)/Math.max(1,total-1);
  chartState={hist,pred,live,mn,mx,pad,w,h,total,step,priceBottom,hoverIndex:Number.isInteger(chartState.hoverIndex)?chartState.hoverIndex:-1};
  const X=i=>pad+i*step,Y=v=>priceBottom-(v-mn)/(mx-mn)*(priceBottom-pad);
  ctx.fillStyle="#0b0f15";ctx.fillRect(0,0,w,h);
  ctx.font="10px Inter, sans-serif";
  ctx.strokeStyle="#202733";ctx.lineWidth=1;
  for(let i=0;i<5;i++){
    const yy=pad+i*(priceBottom-pad)/4,val=mx-(mx-mn)*i/4;
    if(!Number.isFinite(yy)||!Number.isFinite(val))continue;
    ctx.beginPath();ctx.moveTo(pad,yy);ctx.lineTo(w-pad,yy);ctx.stroke();
    ctx.fillStyle="#8993a4";ctx.fillText(fmt(val),7,yy+3);
  }
  const ticks=Math.min(chartState.intraday?8:6,hist.length);
  for(let k=0;k<ticks;k++){
    const idx=Math.round(k*(hist.length-1)/Math.max(1,ticks-1)),xx=X(idx);
    ctx.fillStyle="#778296";ctx.fillText(shortDate(hist[idx]?.date||""),Math.max(pad,Math.min(w-pad-40,xx-20)),h-8);
  }
  const type=$("chartType").value;
  if(type==="candles"){
    const cw=Math.max(2,Math.min(12,Math.abs(step)*.62));
    hist.forEach((v,i)=>{
      if(![v.open,v.high,v.low,v.close].every(Number.isFinite))return;
      const up=v.close>=v.open;
      ctx.strokeStyle=up?"#79e38b":"#ff7f7f";ctx.fillStyle=up?"#79e38b":"#ff7f7f";ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(X(i),Y(v.high));ctx.lineTo(X(i),Y(v.low));ctx.stroke();
      const top=Y(Math.max(v.open,v.close)),bot=Y(Math.min(v.open,v.close));
      ctx.fillRect(X(i)-cw/2,top,cw,Math.max(1,bot-top));
    });
  }else{
    ctx.strokeStyle="#e9edf3";ctx.lineWidth=2;ctx.beginPath();
    hist.forEach((v,i)=>{if(!Number.isFinite(v.close))return;i?ctx.lineTo(X(i),Y(v.close)):ctx.moveTo(X(i),Y(v.close));});ctx.stroke();
    if(type==="area"&&hist.length){
      ctx.lineTo(X(hist.length-1),priceBottom);ctx.lineTo(X(0),priceBottom);ctx.closePath();
      ctx.globalAlpha=.10;ctx.fillStyle="#e9edf3";ctx.fill();ctx.globalAlpha=1;
    }
  }
  if(pred.length&&hist.length){
    const forecastStart=hist.length-1;
    ctx.strokeStyle="#a9ff6b";ctx.lineWidth=3;ctx.setLineDash([7,5]);ctx.beginPath();
    ctx.moveTo(X(forecastStart),Y(hist.at(-1).close));
    pred.forEach((v,j)=>{
      const x=X(forecastStart+j+1);
      if(Number.isFinite(x)&&Number.isFinite(v.close))ctx.lineTo(x,Y(v.close));
    });
    ctx.stroke();ctx.setLineDash([]);
    const lastPred=pred.at(-1);
    const lx=X(forecastStart+pred.length);
    const ly=Y(lastPred.close);
    if(Number.isFinite(lx)&&Number.isFinite(ly)){
      ctx.setLineDash([]);ctx.fillStyle="#a9ff6b";ctx.beginPath();ctx.arc(lx,ly,4,0,Math.PI*2);ctx.fill();
      ctx.font="10px Inter, sans-serif";ctx.fillText("KRONOS",Math.max(pad,Math.min(w-pad-48,lx-24)),Math.max(pad+12,ly-8));
    }
  }
  const maxVol=Math.max(1,...hist.map(v=>Number.isFinite(v.volume)?v.volume:0));
  const volTop=priceBottom+8,volBottom=h-pad-18;
  hist.forEach((v,i)=>{
    const vh=(v.volume/maxVol)*Math.max(2,volBottom-volTop),cw=Math.max(2,Math.min(10,Math.abs(step)*.7));
    ctx.fillStyle=v.close>=v.open?"#79e38b66":"#ff7f7f66";ctx.fillRect(X(i)-cw/2,volBottom-vh,cw,vh);
  });
  ctx.fillStyle="#586476";ctx.font="8px Inter, sans-serif";ctx.fillText("VOLUME",pad,volTop+9);
  if(live!==null&&hist.length){
    const lx=X(hist.length-1),ly=Y(live);
    if(Number.isFinite(ly)){
      ctx.strokeStyle="#5bd6ff";ctx.lineWidth=1;ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(pad,ly);ctx.lineTo(w-pad,ly);ctx.stroke();ctx.setLineDash([]);
      ctx.fillStyle="#5bd6ff";ctx.beginPath();ctx.arc(lx,ly,4,0,Math.PI*2);ctx.fill();
      ctx.font="9px Inter, sans-serif";ctx.fillText("LIVE "+fmt(live),Math.max(pad,w-pad-72),Math.max(pad+10,ly-7));
    }
  }
  const hi=chartState.hoverIndex;
  if(Number.isInteger(hi)&&hi>=0&&hi<hist.length){
    const v=hist[hi],xx=X(hi),yy=Y(v.close);
    ctx.strokeStyle="#66738488";ctx.lineWidth=1;ctx.setLineDash([2,3]);
    ctx.beginPath();ctx.moveTo(xx,pad);ctx.lineTo(xx,priceBottom);ctx.stroke();
    ctx.beginPath();ctx.moveTo(pad,yy);ctx.lineTo(w-pad,yy);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle="#e9edf3";ctx.beginPath();ctx.arc(xx,yy,3,0,Math.PI*2);ctx.fill();
  }
}function shortDate(s){
 const d=new Date(s);
 if(Number.isNaN(d.getTime()))return String(s).slice(0,10);
 if(chartState.intraday)return d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
 return d.toLocaleDateString(undefined,{day:"2-digit",month:"short"});
}
function chartHover(e){
  if(!chartState.hist.length)return;
  const c=$("chart"),r=c.getBoundingClientRect(),px=e.clientX-r.left,pad=chartState.pad,step=chartState.step||((chartState.w-pad*2)/Math.max(1,chartState.total-1));
  let i=Math.round((px-pad)/step);i=Math.max(0,Math.min(chartState.hist.length-1,i));
  chartState.hoverIndex=i;renderChartOnly();
  const v=chartState.hist[i],tip=$("chartTip");if(!v)return;
  tip.classList.remove("hidden");
  tip.innerHTML="<b>"+new Date(v.date).toLocaleString()+"</b><span>O "+fmt(v.open)+" · H "+fmt(v.high)+" · L "+fmt(v.low)+" · C "+fmt(v.close)+"</span><span>Volume "+Number(v.volume||0).toLocaleString()+"</span>";
  tip.style.left=Math.min(Math.max(px+12,8),Math.max(8,c.clientWidth-205))+"px";
  tip.style.top=Math.max(8,e.clientY-r.top-58)+"px";
}
function chartWheel(e){
  e.preventDefault();
  if(!chartState.hist.length)return;
  if(chartState.intraday){
    const current=$("intradayRange").value||"1d",opts=["1d","5d","1mo"];
    const pos=Math.max(0,opts.indexOf(current)),next=e.deltaY<0?Math.min(opts.length-1,pos+1):Math.max(0,pos-1);
    $("intradayRange").value=opts[next];loadChartMode();return;
  }
  const current=Number($("range").value||252),opts=[5,22,66,132,252,400];
  const pos=Math.max(0,opts.indexOf(current)),next=e.deltaY<0?Math.min(opts.length-1,pos+1):Math.max(0,pos-1);
  $("range").value=String(opts[next]);render();
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
