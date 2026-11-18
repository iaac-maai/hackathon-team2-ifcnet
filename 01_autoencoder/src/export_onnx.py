"""Export data/gcn_autoencoder.pt to 01_autoencoder/model/model.onnx and check it matches PyTorch.

Run from anywhere:  python 01_autoencoder/src/export_onnx.py  (or paste into a notebook cell)
"""

import inspect
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from torch_geometric.data import Batch

# Repo root: __file__ does not exist in a notebook, so walk up from the current folder instead
try:
    start = Path(__file__).resolve().parent
except NameError:
    start = Path.cwd().resolve()
REPO = next(p for p in [start, *start.parents] if (p / "01_autoencoder" / "src").is_dir())
sys.path.insert(0, str(REPO / "01_autoencoder" / "src"))
from graph_autoencoder import GraphAutoencoder, LazyGraphDataset   # P2's model + lazy dataset

DATA = REPO / "data"
OUT = REPO / "01_autoencoder" / "model"
OUT.mkdir(parents=True, exist_ok=True)

# 1) Load the trained model (same settings as in the notebook)
ck = torch.load(DATA / "gcn_autoencoder.pt", map_location="cpu", weights_only=False)
model = GraphAutoencoder(latent_dim=ck.get("latent_dim", 32), hidden_dim=64)
model.load_state_dict(ck["model"])
model.eval()


# 2) Wrapper: ONNX only takes plain tensors, so call encode/decode directly
class OnnxWrapper(torch.nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, x, edge_index):
        batch = torch.zeros(x.shape[0], dtype=torch.long)    # one graph
        z = self.net.encode(x, edge_index, batch)
        return self.net.decode(z), z


# 3) A real graph as example input (only builds the graphs we index)
val_graphs = LazyGraphDataset(DATA / "ifc_graphs" / "val.pt")
g0 = val_graphs[0]
x0 = g0.x.float()
ei0 = g0.edge_index.long()

kw = dict(input_names=["x", "edge_index"],
          output_names=["reconstruction", "latent"],
          dynamic_axes={"edge_index": {1: "n_edges"}},
          opset_version=17)
if "dynamo" in inspect.signature(torch.onnx.export).parameters:
    kw["dynamo"] = False

onnx_path = OUT / "model.onnx"
with torch.no_grad():
    torch.onnx.export(OnnxWrapper(model).eval(), (x0, ei0), str(onnx_path), **kw)
print("exported", onnx_path, round(onnx_path.stat().st_size / 1e6, 2), "MB")

# 4) Check: same graphs through PyTorch (the normal way) and through ONNX
sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
worst = 0.0
for g in val_graphs[:5]:
    with torch.no_grad():
        r_pt, z_pt = model(Batch.from_data_list([g]))
    r_ox, z_ox = sess.run(None, {"x": g.x.numpy().astype(np.float32),
                                 "edge_index": g.edge_index.numpy().astype(np.int64)})
    d_rec = float(np.abs(r_ox.reshape(-1) - r_pt.numpy().reshape(-1)).max())
    d_lat = float(np.abs(z_ox.reshape(-1) - z_pt.numpy().reshape(-1)).max())
    worst = max(worst, d_rec, d_lat)
    print(f"{g.object_id[:8]}  max diff reconstruction {d_rec:.2e}  latent {d_lat:.2e}")

assert worst < 1e-4, "ONNX and PyTorch disagree -> do not use this file"
print("ONNX check OK: matches PyTorch")
