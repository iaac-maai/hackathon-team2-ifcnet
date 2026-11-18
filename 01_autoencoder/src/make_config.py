"""Compute the threshold, copy example IFC files and write 01_autoencoder/model/config.json.

Run after export_onnx.py:  python 01_autoencoder/src/make_config.py  (or paste into a notebook cell)
"""

import json
import shutil
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import pandas as pd

# Repo root: __file__ does not exist in a notebook, so walk up from the current folder instead
try:
    start = Path(__file__).resolve().parent
except NameError:
    start = Path.cwd().resolve()
REPO = next(p for p in [start, *start.parents] if (p / "01_autoencoder" / "src").is_dir())
sys.path.insert(0, str(REPO / "01_autoencoder" / "src"))
import ifc_graph
from graph_autoencoder import LazyGraphDataset

DATA = REPO / "data"
OUT = REPO / "01_autoencoder" / "model"
ANOM = ["IfcStair", "IfcRailing"]       # same anomaly classes as the notebook
SCORE_POINTS = 256                      # notebook compares the first 256 points (LOSS_POINTS)

sess = ort.InferenceSession(str(OUT / "model.onnx"), providers=["CPUExecutionProvider"])
split = pd.read_csv(REPO / "01_autoencoder" / "splits" / "ifc_split.csv")


def chamfer(a, b):
    """Chamfer distance: for each point, distance to the closest point of the other cloud (both ways)."""
    d = ((a[:, None, :] - b[None, :, :]) ** 2).sum(-1)
    return float(d.min(1).mean() + d.min(0).mean())


def run_graph(g):
    """graph -> ONNX -> (score, latent)."""
    recon, z = sess.run(None, {"x": g.x.numpy().astype(np.float32),
                               "edge_index": g.edge_index.numpy().astype(np.int64)})
    s = chamfer(recon.reshape(-1, 3)[:SCORE_POINTS], g.pos.numpy()[:SCORE_POINTS])
    return s, z[0]


# 1) Threshold = 95th percentile of the score on NORMAL validation objects
normal_val_ids = split.loc[(split["split"] == "val") & ~split["ifc_class"].isin(ANOM), "object_id"]
val = LazyGraphDataset(DATA / "ifc_graphs" / "val.pt", normal_val_ids)   # builds one graph at a time
normal_scores = np.array([run_graph(val[i])[0] for i in range(len(val))])
thr = float(np.quantile(normal_scores, 0.95))
print(f"threshold (95th pct of {len(normal_scores)} normal val objects): {thr:.6f}")

# 2) Three example IFC files from the TEST set: 2 normal + 1 anomaly
ex_dir = OUT / "examples"
ex_dir.mkdir(parents=True, exist_ok=True)
for f in ex_dir.glob("*.ifc"):
    f.unlink()
test = split[split["split"] == "test"].sort_values("object_id")
for cls, kind in [("IfcDoor", "normal"), ("IfcWall", "normal"), ("IfcStair", "anomaly")]:
    row = test[test["ifc_class"] == cls].iloc[0]
    shutil.copy(DATA / row["path"], ex_dir / f"{kind}_{cls}.ifc")

# 3) config.json: everything the server needs
from importlib.metadata import version, PackageNotFoundError


def pkg_version(name):
    try:
        return version(name)
    except PackageNotFoundError:
        return "not installed"


cfg = {
    "model_file": "model.onnx",
    "model_name": "GCN graph autoencoder (data/gcn_autoencoder.pt)",
    "inputs": {"x": "[1024, 3] float32, normalised xyz of the points",
               "edge_index": "[2, 16384] int64, kNN edges (16 neighbours)"},
    "outputs": {"reconstruction": "[1, 1024, 3]", "latent": f"[1, {sess.get_outputs()[1].shape[-1]}]"},
    "preprocessing": {
        "function": "ifc_graph.ifc_to_graph(path)",
        "n_points": ifc_graph.N_POINTS,
        "k_neighbours": ifc_graph.K_NEIGHBOURS,
        "seed": ifc_graph.SEED,
        "notes": "IFC -> mesh in world coordinates -> sample points -> centre + scale -> kNN graph",
    },
    "score": "Chamfer distance between reconstruction and input points (first 256 points)",
    "score_points": SCORE_POINTS,
    "threshold": thr,
    "threshold_rule": "95th percentile of the score on normal validation objects",
    "decision": "score > threshold -> 'unusual object, check it'",
    "anomaly_classes_used_in_eval": ANOM,
    "built_with": {"python": sys.version.split()[0], "torch": pkg_version("torch"),
                   "torch_geometric": pkg_version("torch_geometric"),
                   "ifcopenshell": ifc_graph.ifcopenshell.version, "onnxruntime": ort.__version__,
                   "gradio": pkg_version("gradio"), "numpy": np.__version__},
}
(OUT / "config.json").write_text(json.dumps(cfg, indent=2))
print("saved", OUT / "config.json")

# 4) Full check from the raw IFC file (same path as the server)
for f in sorted(ex_dir.glob("*.ifc")):
    s, z = run_graph(ifc_graph.ifc_to_graph(f))
    print(f"{f.name:25s} score {s:.6f}  {'UNUSUAL' if s > thr else 'ok'}   latent size {len(z)}")
