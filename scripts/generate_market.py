import json, os, time, sys
from pathlib import Path
import numpy as np
import pandas as pd
import torch
import yfinance as yf

sys.path.insert(0, "/tmp/Kronos")
from model import Kronos, KronosTokenizer, KronosPredictor

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/"web"/"data"/"market.json"

# Broad liquid universe for the free scheduled pipeline.
# This is intentionally curated rather than literally every listed security,
# because free CI inference time is finite. CSV remains available for any custom ticker.
SYMBOLS=[
    "RELIANCE.NS","IDEA.NS","BTC-USD","XAUUSD=X","INFY.NS"
]

HORIZONS=[5,10,20,30]
LOOKBACK=400

# Intraday forecasts use the same original Kronos-small predictor, but on real
# 5m/15m/1h OHLCV candles. Keep the set curated so the free GitHub Actions
# pipeline stays within its time budget.
INTRADAY_SYMBOLS={
    "RELIANCE.NS","IDEA.NS","BTC-USD","XAUUSD=X","INFY.NS"
}
INTRADAY_CONFIG={
    "5m":{"period":"60d","pred_len":24,"history_bars":600},
    "15m":{"period":"60d","pred_len":16,"history_bars":600},
    "1h":{"period":"730d","pred_len":12,"history_bars":600},
}
GROUP_INDEX=int(os.getenv("GROUP_INDEX","0"))
GROUP_COUNT=max(1,int(os.getenv("GROUP_COUNT","1")))
MODEL_ID="NeoQuasar/Kronos-small"
TOKENIZER_ID="NeoQuasar/Kronos-Tokenizer-base"

def future_dates(last, n, symbol):
    d=pd.Timestamp(last)+pd.Timedelta(days=1)
    dates=[]
    crypto=symbol.endswith("-USD")
    while len(dates)<n:
        if crypto or d.weekday()<5:
            dates.append(d)
        d+=pd.Timedelta(days=1)
    return pd.Series(dates)

def load_yahoo_chart(symbol, interval, range_):
    import requests
    last_error=None
    for host in ("query1.finance.yahoo.com","query2.finance.yahoo.com"):
        try:
            url="https://"+host+"/v8/finance/chart/"+symbol
            params={"interval":interval,"range":range_,"includePrePost":"false","events":"div,splits"}
            r=requests.get(url,params=params,headers={"User-Agent":"Mozilla/5.0 (compatible; KronosAI/1.0)"},timeout=20)
            r.raise_for_status()
            result=r.json().get("chart",{}).get("result") or []
            if not result: continue
            res=result[0]; ts=res.get("timestamp") or []
            q=(res.get("indicators",{}).get("quote") or [{}])[0]
            rows=[]
            for i,t in enumerate(ts):
                vals=[q.get(k,[None]*len(ts))[i] for k in ("open","high","low","close")]
                vol=(q.get("volume") or [0]*len(ts))[i] or 0
                if all(v is not None for v in vals):
                    rows.append((pd.to_datetime(t,unit="s",utc=True).tz_localize(None),*map(float,vals),float(vol)))
            if rows:
                print("Yahoo chart fallback OK",symbol,interval,range_,len(rows),host)
                return pd.DataFrame(rows,columns=["date","open","high","low","close","volume"])
        except Exception as e:
            last_error=e
            print("Yahoo chart fallback failed",symbol,interval,range_,host,repr(e))
    return None

def flatten_yf_frame(raw, symbol):
    if raw is None or raw.empty: return None
    if isinstance(raw.columns,pd.MultiIndex):
        # yfinance may return either (field, ticker) or (ticker, field).
        if symbol in raw.columns.get_level_values(-1):
            raw=raw.xs(symbol,axis=1,level=-1,drop_level=True)
        elif symbol in raw.columns.get_level_values(0):
            raw=raw.xs(symbol,axis=1,level=0,drop_level=True)
        else:
            raw.columns=[str(c[-1] if isinstance(c,tuple) else c) for c in raw.columns]
    raw=raw.rename(columns={c:str(c).lower() for c in raw.columns})
    return raw

def load_symbol(symbol):
    try:
        raw=yf.download(symbol,period="2y",interval="1d",auto_adjust=False,repair=True,progress=False,threads=False)
        raw=flatten_yf_frame(raw,symbol)
    except Exception as e:
        print("yfinance daily failed",symbol,repr(e)); raw=None
    if raw is None or raw.empty:
        raw=load_yahoo_chart(symbol,"1d","2y")
    if raw is None or raw.empty:
        return None
    need=["open","high","low","close","volume"]
    if not all(c in raw.columns for c in need): return None
    raw=raw[need].dropna().reset_index()
    if "Date" in raw.columns: raw=raw.rename(columns={"Date":"date"})
    raw["date"]=pd.to_datetime(raw["date"]).dt.tz_localize(None)
    return raw

def validate_ohlcv(df):
    """Drop malformed candles and enforce chronological, finite OHLCV data."""
    if df is None or df.empty:
        return None
    df=df.copy()
    required=["date","open","high","low","close","volume"]
    if not all(col in df.columns for col in required):
        return None
    df["date"]=pd.to_datetime(df["date"],errors="coerce")
    if getattr(df["date"].dt,"tz",None) is not None:
        df["date"]=df["date"].dt.tz_localize(None)
    for col in required[1:]:
        df[col]=pd.to_numeric(df[col],errors="coerce")
    df=df.dropna(subset=required)
    df=df[np.isfinite(df[required[1:]].to_numpy()).all(axis=1)]
    # OHLC invariants: high/low must contain both open and close; prices/volume non-negative.
    valid=(
        (df["open"]>0)&(df["high"]>0)&(df["low"]>0)&(df["close"]>0)&(df["volume"]>=0)&
        (df["high"]>=df[["open","close","low"]].max(axis=1))&
        (df["low"]<=df[["open","close","high"]].min(axis=1))
    )
    df=df.loc[valid].drop_duplicates(subset=["date"],keep="last").sort_values("date").reset_index(drop=True)
    return df if not df.empty else None

def validate_forecast(pred, y_ts):
    """Reject non-finite/invalid forecast candles before publishing them."""
    if pred is None or len(pred)!=len(y_ts):
        return False
    cols=[c for c in ("open","high","low","close","volume") if c in pred.columns]
    if not {"open","high","low","close"}.issubset(cols):
        return False
    a=pred[cols].apply(pd.to_numeric,errors="coerce")
    if not np.isfinite(a.to_numpy()).all():
        return False
    if (a[["open","high","low","close"]]<=0).any().any():
        return False
    if "volume" in a.columns and (a["volume"]<0).any():
        return False
    valid=(a["high"]>=a[["open","close","low"]].max(axis=1))&(a["low"]<=a[["open","close","high"]].min(axis=1))
    return bool(valid.all())

def predict_one(predictor, df, n, symbol):
    x=df.tail(LOOKBACK).copy()
    x_ts=x["date"]
    y_ts=future_dates(x_ts.iloc[-1],n,symbol)
    x_df=x[["open","high","low","close","volume"]].copy()
    with torch.no_grad():
        p=predictor.predict(df=x_df,x_timestamp=x_ts,y_timestamp=y_ts,pred_len=n,T=1.0,top_p=0.9,sample_count=1,verbose=False)
    if not validate_forecast(p,y_ts):
        raise RuntimeError(f"Invalid Kronos forecast for {symbol} daily")
    return [{"date":str(d.date()),"close":float(v)} for d,v in zip(y_ts,p["close"].values)]

def rolling_backtest(predictor, df, horizon=5, windows=8):
    if len(df)<LOOKBACK+horizon+5: return None
    errors=[]; dirs=[]; points=[]; ape=[]
    starts=np.linspace(LOOKBACK,len(df)-horizon,windows,dtype=int)
    starts=np.unique(starts).astype(int)
    windows=len(starts)
    for end in starts:
        hist=df.iloc[:end]
        actual=df.iloc[end:end+horizon]["close"].values
        x=hist.tail(LOOKBACK)
        y_ts=pd.Series(df.iloc[end:end+horizon]["date"].values)
        with torch.no_grad():
            p=predictor.predict(df=x[["open","high","low","close","volume"]],x_timestamp=x["date"],y_timestamp=y_ts,pred_len=horizon,T=1.0,top_p=0.9,sample_count=1,verbose=False)
        pred=p["close"].values
        errors.extend(actual-pred)
        dirs.extend((np.sign(actual-x["close"].iloc[-1])==np.sign(pred-x["close"].iloc[-1])).astype(float))
        ape.extend(np.abs((actual-pred)/np.maximum(np.abs(actual),1e-9))*100)
        points.extend([{"date":str(d.date()),"actual":float(a),"kronos":float(v)} for d,a,v in zip(y_ts,actual,pred)])
    e=np.asarray(errors,float)
    return {"windows":int(windows),"horizon":int(horizon),"mae":float(np.mean(np.abs(e))),"rmse":float(np.sqrt(np.mean(e**2))),"mape":float(np.mean(ape)),"direction":float(np.mean(dirs)*100),"points":points}

def intraday_future_dates(last, interval, n, symbol):
    last=pd.Timestamp(last)
    step=pd.Timedelta(minutes={"5m":5,"15m":15,"1h":60}[interval])
    crypto=symbol.endswith("-USD")
    is_india=symbol.endswith(".NS")
    if crypto:
        return pd.Series([last+step*i for i in range(1,n+1)])
    # Forecast only inside the regular session. The first prediction starts
    # exactly one interval after the latest actual candle, then skips overnight
    # and weekend gaps without inventing candles outside the session.
    if is_india:
        start=pd.Timedelta(hours=9,minutes=15)
        end=pd.Timedelta(hours=15,minutes=30)
    else:
        start=pd.Timedelta(hours=9,minutes=30)
        end=pd.Timedelta(hours=16)
    out=[]
    cur=last+step
    while len(out)<n:
        day=cur.normalize()
        if cur.weekday()<5:
            session_start=day+start
            session_end=day+end
            if cur<session_start:
                cur=session_start
            if cur<=session_end:
                while cur<=session_end and len(out)<n:
                    out.append(cur)
                    cur+=step
                continue
        cur=(day+pd.Timedelta(days=1))+start
    return pd.Series(out[:n])

def load_intraday(symbol, interval, period):
    try:
        raw=yf.download(symbol,period=period,interval=interval,auto_adjust=False,repair=True,progress=False,threads=False)
        raw=flatten_yf_frame(raw,symbol)
    except Exception as e:
        print("yfinance intraday failed",symbol,interval,repr(e)); raw=None
    if raw is None or raw.empty:
        raw=load_yahoo_chart(symbol,interval,period)
    if raw is None or raw.empty: return None
    need=["open","high","low","close","volume"]
    if not all(c in raw.columns for c in need): return None
    raw=raw[need].dropna().reset_index()
    ts_col="Datetime" if "Datetime" in raw.columns else ("Date" if "Date" in raw.columns else raw.columns[0])
    raw=raw.rename(columns={ts_col:"date"})
    raw["date"]=pd.to_datetime(raw["date"])
    if getattr(raw["date"].dt,"tz",None) is not None:
        raw["date"]=raw["date"].dt.tz_localize(None)
    return validate_ohlcv(raw)

def predict_intraday_one(predictor, df, interval, pred_len, symbol):
    if df is None or len(df)<LOOKBACK: return []
    x=df.tail(LOOKBACK).copy()
    x_ts=x["date"]
    y_ts=intraday_future_dates(x_ts.iloc[-1],interval,pred_len,symbol)
    with torch.no_grad():
        p=predictor.predict(
            df=x[["open","high","low","close","volume"]],
            x_timestamp=x_ts,
            y_timestamp=y_ts,
            pred_len=pred_len,T=1.0,top_p=0.9,sample_count=1,verbose=False
        )
    if not validate_forecast(p,y_ts):
        raise RuntimeError(f"Invalid Kronos forecast for {symbol} {interval}")
    return [{"date":str(d.isoformat()),"close":float(v)} for d,v in zip(y_ts,p["close"].values)]

def main():
    device="cuda" if torch.cuda.is_available() else "cpu"
    tokenizer=KronosTokenizer.from_pretrained(TOKENIZER_ID)
    model=Kronos.from_pretrained(MODEL_ID)
    tokenizer.eval(); model.eval()
    predictor=KronosPredictor(model,tokenizer,device=device,max_context=512)
    result={"generated_at":pd.Timestamp.utcnow().isoformat(),"source":"Yahoo Finance via yfinance (unofficial historical market-data interface)","model":{"name":"Kronos-small","id":MODEL_ID,"tokenizer":TOKENIZER_ID,"device":device,"lookback":LOOKBACK},"symbols":{}}
    symbols = SYMBOLS[GROUP_INDEX::GROUP_COUNT] if GROUP_COUNT > 1 else SYMBOLS
    print("Group", GROUP_INDEX, "of", GROUP_COUNT, "symbols", len(symbols))
    for symbol in symbols:
        try:
            df=load_symbol(symbol)
            if df is None or len(df)<LOOKBACK: continue
            item={"symbol":symbol,"last_date":str(df["date"].iloc[-1].date()),"last_close":float(df["close"].iloc[-1]),"history":[{"date":str(row["date"].date()),"open":float(row["open"]),"high":float(row["high"]),"low":float(row["low"]),"close":float(row["close"]),"volume":float(row["volume"])} for _,row in df.tail(400).iterrows()],"forecast":{}}
            for h in HORIZONS:
                item["forecast"][str(h)]=predict_one(predictor,df,h,symbol)
            item["backtest"]=rolling_backtest(predictor,df,5,3)
            item["intraday"]={}
            if symbol in INTRADAY_SYMBOLS:
                for interval,cfg in INTRADAY_CONFIG.items():
                    try:
                        idf=load_intraday(symbol,interval,cfg["period"])
                        if idf is not None and len(idf)>=LOOKBACK:
                            item["intraday"][interval]={
                                "generated_at":pd.Timestamp.utcnow().isoformat(),
                                "bars":int(len(idf)),
                                "last_date":str(idf["date"].iloc[-1].isoformat()),
                                "history":[{"date":str(row["date"].isoformat()),"open":float(row["open"]),"high":float(row["high"]),"low":float(row["low"]),"close":float(row["close"]),"volume":float(row["volume"])} for _,row in idf.tail(cfg.get("history_bars",600)).iterrows()],
                                "forecast":predict_intraday_one(predictor,idf,interval,cfg["pred_len"],symbol)
                            }
                            if not item["intraday"][interval]["forecast"]:
                                raise RuntimeError(f"Empty Kronos forecast for {symbol} {interval}")
                            print("OK INTRADAY",symbol,interval,"history",len(item["intraday"][interval]["history"]),"forecast",len(item["intraday"][interval]["forecast"]))
                    except Exception as ie:
                        print("SKIP INTRADAY",symbol,interval,repr(ie))
            result["symbols"][symbol]=item
            print("OK",symbol)
        except Exception as e:
            print("SKIP",symbol,repr(e))
    OUT.parent.mkdir(parents=True,exist_ok=True)
    if GROUP_COUNT > 1:
        out = OUT.with_name(f"market-group-{GROUP_INDEX}.json")
    else:
        out = OUT
    out.write_text(json.dumps(result,separators=(",",":")),encoding="utf-8")
    print("Wrote",out,"symbols",len(result["symbols"]))

if __name__=="__main__": main()
