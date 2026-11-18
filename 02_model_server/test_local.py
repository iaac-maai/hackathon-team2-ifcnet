"""Call the running model server with a few IFC files.

Usage:
    python test_local.py                         # server at http://127.0.0.1:7860
    python test_local.py <server-url>            # e.g. a *.gradio.live or Render URL
    python test_local.py <server-url> a.ifc b.ifc

IFC files are taken from (first that has files):
  1. the paths given on the command line
  2. model/examples/*.ifc
  3. one test file per class from data/IFCNetCoreIFC (local dataset, never uploaded)
"""
import sys
from pathlib import Path

from gradio_client import Client, handle_file

HERE = Path(__file__).resolve().parent
url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:7860"

files = [Path(p) for p in sys.argv[2:]]
if not files:
    files = sorted((HERE / "model" / "examples").glob("*.ifc"))
if not files:
    data = HERE.parent / "data" / "IFCNetCoreIFC"
    for cls in ["IfcDoor", "IfcWall", "IfcPipeSegment", "IfcStair", "IfcRailing"]:
        files += sorted((data / cls / "test").glob("*.ifc"))[:1]
if not files:
    sys.exit("No IFC files found: pass some on the command line or put them in model/examples/.")

missing = [f for f in files if not f.is_file()]
if missing:
    sys.exit(f"File(s) not found: {', '.join(map(str, missing))}")

try:
    client = Client(url, verbose=False)
except Exception as exc:  # httpx.ConnectError etc.
    sys.exit(f"Cannot reach the server at {url} ({type(exc).__name__}).\n"
             "Start it first in ANOTHER terminal and wait for 'Running on local URL':\n"
             "    python 02_model_server/app.py\n"
             "then run this test again. If the server uses another port or a share link, pass it:\n"
             "    python 02_model_server/test_local.py http://127.0.0.1:<port>")
print(f"server: {url}\n")
for f in files:
    name = f"{f.parent.parent.name}/{f.name}" if f.parent.name == "test" else f.name
    p = client.predict(handle_file(str(f)), api_name="/predict")
    e = client.predict(handle_file(str(f)), api_name="/embed")
    verdict = "UNUSUAL" if p["unusual"] else "typical"
    print(f"{name[:45]:45s} score {p['score']:.4f} (thr {p['threshold']:.4f}) -> {verdict:8s} latent size {len(e['latent'])}")
print(f"\nOK: {len(files)} file(s) checked")
