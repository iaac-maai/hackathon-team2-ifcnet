"""Compare the model's scores on our three.js renders with IFCNet's own renders of the same objects.

Usage (repo root, hackathon env):
    python experiments/render_test/compare_scores.py <folder with our renders>

Our renders are named <object_id>.<view>.png (the HTML page names them like that).
The script finds IFCNet's PNG of the same object and view under data/ and scores both.
"""
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

ours_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "experiments/render_test/renders")
cfg = json.load(open("01_autoencoder/models/config.json"))
sess = ort.InferenceSession("01_autoencoder/models/model.onnx", providers=["CPUExecutionProvider"])
size, thr = cfg["preprocessing"]["img_size"], cfg["threshold"]

def prep(path):
    im = Image.open(path).convert("L").resize((size, size))
    return (1 - np.asarray(im, np.float32) / 255)[None, None]      # same steps as training

def score(path):
    return float(sess.run(["score"], {"image": prep(path)})[0][0])

# index IFCNet PNGs by file name
ifcnet = {p.name: p for p in Path("data").glob("Ifc*/*/*.png")}

print(f"{'file':45s} {'ours':>8s} {'IFCNet':>8s}   verdict ours / IFCNet")
diffs = []
for p in sorted(ours_dir.glob("*.png")):
    s_ours = score(p)
    ref = ifcnet.get(p.name)
    if ref is None:
        print(f"{p.name:45s} {s_ours:8.4f} {'-':>8s}   (no IFCNet render with this name)")
        continue
    s_ref = score(ref)
    diffs.append(abs(s_ours - s_ref))
    v = lambda s: "UNUSUAL" if s > thr else "ok"
    print(f"{p.name:45s} {s_ours:8.4f} {s_ref:8.4f}   {v(s_ours)} / {v(s_ref)}   ({ref.parent.parent.name})")

if diffs:
    print(f"\nmean |difference| = {np.mean(diffs):.4f}   threshold = {thr:.4f}")
    print("Good if the differences are much smaller than the threshold and the verdicts mostly agree.")
