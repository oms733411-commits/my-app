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
 # India / NSE
 "RELIANCE.NS","TCS.NS","INFY.NS","HDFCBANK.NS","ICICIBANK.NS","SBIN.NS",
 "BHARTIARTL.NS","ITC.NS","LT.NS","HINDUNILVR.NS","KOTAKBANK.NS","AXISBANK.NS",
 "MARUTI.NS","SUNPHARMA.NS","TATAMOTORS.NS","M&M.NS","BAJFINANCE.NS",
 "HCLTECH.NS","WIPRO.NS","ADANIENT.NS","ADANIPORTS.NS","NTPC.NS","POWERGRID.NS",
 "ONGC.NS","COALINDIA.NS","TATASTEEL.NS","JSWSTEEL.NS","TECHM.NS","ULTRACEMCO.NS",
 "ASIANPAINT.NS","NESTLEIND.NS","TITAN.NS","BAJAJFINSV.NS","DRREDDY.NS",
 "CIPLA.NS","EICHERMOT.NS","HEROMOTOCO.NS","APOLLOHOSP.NS","DIVISLAB.NS",
 "BRITANNIA.NS","GRASIM.NS","HINDALCO.NS","INDUSINDBK.NS","TATACONSUM.NS",
 "BEL.NS","TRENT.NS","BPCL.NS","SHRIRAMFIN.NS","BAJAJ-AUTO.NS","IDEA.NS",
 # US
 "AAPL","MSFT","GOOGL","AMZN","NVDA","TSLA","META","NFLX","AMD","AVGO",
 "JPM","V","MA","WMT","COST","ORCL","CRM","ADBE","INTC","QCOM",
 # Crypto / commodities / gold
 "BTC-USD","ETH-USD","GC=F","XAUUSD=X"
]

HORIZONS=[5,10,20,30]
LOOKBACK=400
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

def load_symbol(symbol):
    raw=yf.download(symbol,period="2y",interval="1d",auto_adjust=False,progress=False,threads=False)
    if raw is None or raw.empty: return None
    if isinstance(raw.columns,pd.MultiIndex):
        raw=raw.xs(symbol,axis=1,level=1,drop_level=True)
    raw=raw.rename(columns={c:str(c).lower() for c in raw.columns})
    need=["open","high","low","close","volume"]
    if not all(c in raw.columns for c in need): return None
    raw=raw[need].dropna().reset_index()
    if "Date" in raw.columns: raw=raw.rename(columns={"Date":"date"})
    raw["date"]=pd.to_datetime(raw["date"]).dt.tz_localize(None)
    return raw

def predict_one(predictor, df, n, symbol):
    x=df.tail(LOOKBACK).copy()
    x_ts=x["date"]
    y_ts=future_dates(x_ts.iloc[-1],n,symbol)
    x_df=x[["open","high","low","close","volume"]].copy()
    with torch.no_grad():
        p=predictor.predict(df=x_df,x_timestamp=x_ts,y_timestamp=y_ts,pred_len=n,T=1.0,top_p=0.9,sample_count=1,verbose=False)
    return [{"date":str(d.date()),"close":float(v)} for d,v in zip(y_ts,p["close"].values)]

def rolling_backtest(predictor, df, horizon=5, windows=3):
    if len(df)<LOOKBACK+horizon+5: return None
    errors=[]; dirs=[]
    starts=np.linspace(LOOKBACK,len(df)-horizon,windows,dtype=int)
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
    e=np.asarray(errors,float)
    return {"windows":int(windows),"horizon":int(horizon),"mae":float(np.mean(np.abs(e))),"rmse":float(np.sqrt(np.mean(e**2))),"direction":float(np.mean(dirs)*100)}

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
