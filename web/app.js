const $=id=>document.getElementById(id);
let rows=[];
let activeSymbol=localStorage.getItem("kronos-symbol")||"RELIANCE.NS";
let dataSource="AUTO";

const symbolInput=$("symbolInput");
symbolInput.value=activeSymbol;
$("csv").addEventListener("change",e=>readCSV(e.target.files[0]));
$("shot").addEventListener("change",e=>{if(e.target.files[0]) $("signalText").textContent="Screenshot attached. Numerical analysis still uses the selected market-data source.";});
$("horizon").addEventListener("change",e=>{ $("horizonOut").textContent=e.target.value; if(rows.length) render(rows); });
$("symbolInput").addEventListener("keydown",e=>{if(e.key==="Enter")loadMarket();});
["dragenter","dragover"].forEach(x=>$("drop").addEventListener(x,e=>{e.preventDefault();$("drop").classList.add("drag");}));
["dragleave","drop"].forEach(x=>$("drop").addEventListener(x,e=>{e.preventDefault();$("drop").classList.remove("drag");}));
$("drop").addEventListener("drop",e=>readCSV(e.dataTransfer.files[0]));

function setStatus(text,ok=true){$("statusText").textContent=text;$("statusDot").classList.toggle("bad",!ok);}
function setBusy(b){$("refreshBtn").disabled=b;$("refreshBtn").textContent=b?"Loading…":"Refresh data";}

async function loadMarket(){
  const s=symbolInput.value.trim().toUpperCase();
  if(!s)return;
  activeSymbol=s; localStorage.setItem("kronos-symbol",s); dataSource="AUTO"; setBusy(true); setStatus("FETCHING MARKET DATA");
  try{
    const url="https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(s)+"?range=2y&interval=1d&events=history&includeAdjustedClose=true";
    const res=await fetch(url,{cache:"no-store"});
    if(!res.ok) throw new Error("Market data request failed");
    const j=await res.json(), r=j.chart?.result?.[0];
    if(!r||!r.timestamp?.length) throw new Error("Symbol not found");
    const q=r.indicators.quote[0];
    rows=r.timestamp.map((ts,i)=>({date:new Date(ts*1000).toISOString().slice(0,10),open:+q.open[i],high:+q.high[i],low:+q.low[i],close:+q.close[i],volume:+q.volume[i]}))
      .filter(x=>Number.isFinite(x.close)&&Number.isFinite(x.open)&&Number.isFinite(x.high)&&Number.isFinite(x.low));
    if(rows.length<60) throw new Error("Not enough history");
    render(rows); setStatus("LIVE DATA • "+new Date().toLocaleTimeString());
  }catch(e){
    setStatus("AUTO DATA UNAVAILABLE",false);
    $("signalText").textContent="Automatic data could not be loaded. You can still use an OHLCV CSV.";
    alert("Could not fetch "+s+". Try another ticker (for example AAPL, MSFT, RELIANCE.NS) or upload CSV.");
  }finally{setBusy(false);}
}

function readCSV(file){
  if(!file)return;
  if(!file.name.toLowerCase().endsWith(".csv"))return alert("Please choose a CSV file.");
  const r=new FileReader();
  r.onload=()=>{try{
    rows=parseCSV(r.result); if(rows.length<60) return alert("Need at least 60 valid OHLCV rows.");
    dataSource="CSV"; render(rows); setStatus("CSV LOADED • LOCAL",true);
  }catch(e){alert("CSV could not be read. Required columns: date/timestamp, open, high, low, close; volume is recommended.");}};
  r.readAsText(file);
}

function parseCSV(t){
  const lines=t.trim().split(/\r?\n/).filter(Boolean);
  const h=lines.shift().split(",").map(x=>x.trim().toLowerCase().replace(/["']/g,""));
  const idx=(names)=>{for(const n of names){const i=h.findIndex(x=>x===n||x.includes(n));if(i>=0)return i;}return -1};
  const ti=idx(["timestamp","datetime","date","time"]),oi=idx(["open"]),hi=idx(["high"]),li=idx(["low"]),ci=idx(["close"]),vi=idx(["volume"]);
  if(Math.min(ti,oi,hi,li,ci)<0)throw Error("missing columns");
  return lines.map(line=>{
    const x=line.split(","); return {date:x[ti]||"",open:Number(x[oi]),high:Number(x[hi]),low:Number(x[li]),close:Number(x[ci]),volume:vi>=0?Number(x[vi]):0};
  }).filter(x=>x.date&&[x.open,x.high,x.low,x.close].every(Number.isFinite));
}

function render(d){
  const last=d.at(-1).close, n=+($("horizon").value.match(/\d+/)||[5])[0], recent=d.slice(-120), vals=recent.map(x=>x.close);
  $("symbol").textContent=(dataSource==="CSV"?"CUSTOM • ":"")+activeSymbol+" • 1D";
  $("last").textContent=fmt(last); $("horizonOut").textContent=n+" sessions";
  const trend=(vals.at(-1)-vals[0])/Math.max(1,Math.abs(vals[0]));
  const dir=trend>=0?"UP":"DOWN"; $("direction").textContent=dir; $("direction").style.color=dir==="UP"?"#a9ff6b":"#ff8f8f";
  $("confidence").textContent=Math.round(Math.min(96,52+Math.abs(trend)*700))+"% trend confidence";
  $("signalText").textContent=dataSource==="AUTO"?"Automatic OHLCV loaded. Forecast engine is ready for the Kronos runtime.":"CSV OHLCV loaded. Forecast engine is ready for the Kronos runtime.";
  const step=(vals.at(-1)-vals[Math.max(0,vals.length-10)])/10;
  $("end").textContent=fmt(last+step*n); draw(vals,n,step); backtest(vals);
}

function draw(vals,n,step){
  const c=$("chart"),x=c.getContext("2d"),dpr=devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;
  c.width=w*dpr;c.height=h*dpr;x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,w,h);
  const forecast=[];for(let i=1;i<=n;i++)forecast.push(vals.at(-1)+step*i);
  const all=vals.concat(forecast),mn=Math.min(...all),mx=Math.max(...all),pad=30;
  const X=i=>pad+i*(w-pad*2)/(all.length-1),Y=v=>h-pad-(v-mn)/(mx-mn||1)*(h-pad*2);
  x.strokeStyle="#202733";x.lineWidth=1;for(let i=0;i<5;i++){const yy=pad+i*(h-pad*2)/4;x.beginPath();x.moveTo(pad,yy);x.lineTo(w-pad,yy);x.stroke();}
  x.lineWidth=2;x.beginPath();vals.forEach((v,i)=>i?x.lineTo(X(i),Y(v)):x.moveTo(X(i),Y(v)));x.strokeStyle="#e9edf3";x.stroke();
  x.setLineDash([5,5]);x.beginPath();forecast.forEach((v,j)=>j?x.lineTo(X(vals.length+j),Y(v)):x.moveTo(X(vals.length-1),Y(vals.at(-1))));x.strokeStyle="#a9ff6b";x.stroke();x.setLineDash([]);
}

function backtest(v){
  if(v.length<30)return;
  let mae=0,rmse=0,correct=0,count=0;
  for(let i=20;i<v.length;i++){
    const actual=v[i],pred=v[i-1],e=actual-pred;mae+=Math.abs(e);rmse+=e*e;
    if(i>20){const actualDir=Math.sign(v[i]-v[i-1]),predDir=Math.sign(v[i-1]-v[i-2]);if(actualDir===predDir)correct++;}
    count++;
  }
  mae/=count;rmse=Math.sqrt(rmse/count);const dir=correct/Math.max(1,count-1)*100;
  $("mae").textContent=fmt(mae);$("rmse").textContent=fmt(rmse);$("dir").textContent=Math.round(dir)+"%";
  $("maeBar").style.width=Math.min(100,Math.max(4,100/(1+mae/Math.max(1,v.at(-1))*20)))+"%";
  $("rmseBar").style.width=Math.min(100,Math.max(4,100/(1+rmse/Math.max(1,v.at(-1))*20)))+"%";
  $("dirBar").style.width=Math.min(100,dir)+"%";
  $("backtestNote").textContent="Baseline sanity-check only. True Kronos-vs-actual rolling backtest will run after the original Kronos runtime is connected.";
}

function fmt(n){return Number(n).toLocaleString(undefined,{maximumFractionDigits:2});}
function loadDemo(){dataSource="DEMO";const d=[];let p=2850;for(let i=0;i<240;i++){p*=1+Math.sin(i/8)*.004+(Math.random()-.48)*.012;d.push({date:"D"+i,open:p,high:p*1.01,low:p*.99,close:p,volume:100000});}rows=d;render(d);setStatus("DEMO DATA",true);}
window.addEventListener("resize",()=>{if(rows.length)render(rows);});
window.addEventListener("load",()=>loadMarket());
setInterval(()=>{if(document.visibilityState==="visible"&&dataSource==="AUTO")loadMarket();},15*60*1000);
