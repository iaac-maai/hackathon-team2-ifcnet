"""Export the trained GCN graph autoencoder for 02_model_server.

Writes 02_model_server/model/model.onnx and model/config.json.
Run from the repo root:  python 01_autoencoder/src/export_gcn_server.py

- ONNX inputs : x [1024, 3] float32, edge_index [2, E] int64 (one graph)
- ONNX outputs: reconstruction [1, 1024, 3], latent [1, 32]
- threshold   : 95th percentile of the Chamfer score on normal validation graphs,
                same rule as the notebook (section 9.1).
"""

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import torch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from graph_autoencoder import GraphAutoencoder, LazyGraphDataset, chamfer_distance  # noqa: E402
import ifc_graph  # noqa: E402

CKPT = ROOT / "data" / "gcn_autoencoder.pt"
OUT = ROOT / "02_model_server" / "model"
ANOMALY_CLASSES = {"IfcStair", "IfcRailing"}


class ServerWrapper(torch.nn.Module):
    """One graph in, (reconstruction, latent) out. The batch vector is all zeros."""

    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, x, edge_index):
        batch = torch.zeros(x.shape[0], dtype=torch.long)
        z = self.net.encode(x, edge_index, batch)
        return self.net.decode(z), z


def main(ckpt=CKPT, out=OUT):
    """Export ``ckpt`` to ``out``/model.onnx + config.json (defaults: the server folder)."""
    out = Path(out)
    ck = torch.load(ckpt, weights_only=False)
    latent_dim = ck.get("latent_dim", 32)
    score_points = ck.get("loss_points", 256)
    model = GraphAutoencoder(latent_dim=latent_dim, hidden_dim=64)
    model.load_state_dict(ck["model"])
    model.eval()

    # threshold from normal validation graphs
    split = pd.read_csv(ROOT / "01_autoencoder" / "splits" / "ifc_split.csv")
    normal_val = set(split.loc[(split["split"] == "val") & ~split["ifc_class"].isin(ANOMALY_CLASSES), "object_id"])
    val = LazyGraphDataset(ROOT / "data" / "ifc_graphs" / "val.pt", normal_val)
    scores = []
    with torch.no_grad():
        for i in range(len(val)):
            g = val[i]
            pred, _ = model(g)  # Data without .batch -> treated as one graph
            scores.append(float(chamfer_distance(pred[:, :score_points], g.pos[None, :score_points])))
    threshold = float(np.quantile(scores, 0.95))
    print(f"threshold (95th pct of {len(scores)} normal val graphs): {threshold:.6f}")

    # ONNX export
    out.mkdir(parents=True, exist_ok=True)
    wrapper = ServerWrapper(model).eval()
    sample = val[0]
    torch.onnx.export(
        wrapper, (sample.x, sample.edge_index), out / "model.onnx",
        input_names=["x", "edge_index"], output_names=["reconstruction", "latent"],
        dynamic_axes={"edge_index": {1: "n_edges"}}, opset_version=17, dynamo=False,
    )

    # check ONNX == PyTorch
    import onnxruntime as ort
    sess = ort.InferenceSession(str(out / "model.onnx"), providers=["CPUExecutionProvider"])
    recon, z = sess.run(None, {"x": sample.x.numpy(), "edge_index": sample.edge_index.numpy()})
    with torch.no_grad():
        ref_recon, ref_z = wrapper(sample.x, sample.edge_index)
    print("max diff recon:", float(np.abs(recon - ref_recon.numpy()).max()),
          "latent:", float(np.abs(z - ref_z.numpy()).max()))

    config = {
        "model_file": "model.onnx",
        "model_name": "gcn_32",
        "task": "anomaly detection by Chamfer reconstruction error + similarity search on the latent vector",
        "inputs": {"x": "[1024, 3] float32, normalised xyz", "edge_index": "[2, 16384] int64, kNN k=16"},
        "outputs": {"reconstruction": "[1, 1024, 3]", "latent": f"[1, {latent_dim}]"},
        "preprocessing": ifc_graph.preprocessing_info(),
        "score": "squared Chamfer distance between the first score_points input and reconstructed points",
        "score_points": score_points,
        "threshold": threshold,
        "threshold_rule": "95th percentile of the score on normal validation graphs",
        "decision": "score > threshold -> unusual",
        "anomaly_classes_used_in_eval": sorted(ANOMALY_CLASSES),
        "built_with": {"torch": torch.__version__, "onnxruntime": ort.__version__,
                       "ifcopenshell": ifc_graph.ifcopenshell.version},
    }
    (out / "config.json").write_text(json.dumps(config, indent=2))
    print("wrote", out / "model.onnx", "and", out / "config.json")


if __name__ == "__main__":
    main()
