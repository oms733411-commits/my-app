from pathlib import Path
import json
import os
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import scripts.generate_market as gm

# Each matrix job owns exactly one symbol. Keep the existing small pipeline
# untouched; this wrapper only changes the model, symbol and output file for
# the separate Kronos-base pipeline.
BASE_SYMBOLS = [
    "RELIANCE.NS",
    "IDEA.NS",
    "BTC-USD",
    "INFY.NS",
]
group_index = int(os.getenv("GROUP_INDEX", "0"))
if group_index < 0 or group_index >= len(BASE_SYMBOLS):
    raise SystemExit(f"Invalid GROUP_INDEX: {group_index}")

symbol = BASE_SYMBOLS[group_index]
BASE_OUT = ROOT / "web" / "data" / f"base-market-group-{group_index}.json"

gm.MODEL_ID = "NeoQuasar/Kronos-base"
gm.OUT = BASE_OUT
gm.SYMBOLS = [symbol]
gm.INTRADAY_SYMBOLS = {symbol}

# The shared generator only uses GROUP_* for its own output naming. Disable
# that grouping here because this wrapper already gives each job its exact
# output filename.
gm.GROUP_INDEX = 0
gm.GROUP_COUNT = 1

gm.main()

if not BASE_OUT.exists():
    raise SystemExit(f"Base output was not created: {BASE_OUT}")

data = json.loads(BASE_OUT.read_text(encoding="utf-8"))
data.setdefault("model", {})
data["model"]["name"] = "Kronos-base"
data["model"]["id"] = "NeoQuasar/Kronos-base"
BASE_OUT.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")

if set(data.get("symbols", {})) != {symbol}:
    raise SystemExit(
        f"Expected exactly {symbol}, got {sorted(data.get('symbols', {}))}"
    )

print("Verified Kronos-base group:", BASE_OUT, "symbol", symbol)
