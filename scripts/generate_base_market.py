from pathlib import Path
import json
import scripts.generate_market as gm

ROOT = Path(__file__).resolve().parents[1]
BASE_OUT = ROOT / "web" / "data" / "base-market.json"

gm.MODEL_ID = "NeoQuasar/Kronos-base"
gm.OUT = BASE_OUT

gm.main()

if BASE_OUT.exists():
    data = json.loads(BASE_OUT.read_text(encoding="utf-8"))
    data.setdefault("model", {})
    data["model"]["name"] = "Kronos-base"
    data["model"]["id"] = "NeoQuasar/Kronos-base"
    BASE_OUT.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print("Verified Kronos-base dataset:", BASE_OUT, "symbols", len(data.get("symbols", {})))
