import hashlib
import json
import os
import sys
import threading
from pathlib import Path

import gradio as gr
import numpy as np
import onnxruntime as ort

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import ifc_graph                      # copy of 01_autoencoder/src/ifc_graph.py (same preprocessing)

# Load model + config ONCE when the server starts.
# model.onnx is git-ignored, so on Render it is downloaded from our Hugging Face repo.
MODEL_DIR = HERE / "model"
HF_REPO = os.environ.get("HF_MODEL_REPO", "iaac-maai/hackathon-team2-ifcnet-gcn")
for _needed in ("config.json", "model.onnx"):
    if not (MODEL_DIR / _needed).is_file():
        try:
            from huggingface_hub import hf_hub_download
            hf_hub_download(HF_REPO, _needed, local_dir=MODEL_DIR)
            print(f"downloaded {_needed} from {HF_REPO}")
        except Exception as exc:
            sys.exit(f"Missing {MODEL_DIR / _needed} and could not download it from {HF_REPO} ({exc}).\n"
                     "Create it from the repo root with:\n"
                     "    python 01_autoencoder/src/export_gcn_server.py\n"
                     "(needs data/gcn_autoencoder.pt and data/ifc_graphs/).")
CFG = json.loads((MODEL_DIR / "config.json").read_text())
SESS = ort.InferenceSession(str(MODEL_DIR / CFG["model_file"]),
                            providers=["CPUExecutionProvider"])
THR = float(CFG["threshold"])
N = int(CFG["score_points"])


def chamfer(a, b):
    d = ((a[:, None, :] - b[None, :, :]) ** 2).sum(-1)
    return float(d.min(1).mean() + d.min(0).mean())


# One converter process for the whole server life (started at launch, reused for
# every request). Starting a fresh Python process per request re-imports
# IfcOpenShell and trimesh each time, which takes 20-40 s on Render's free CPU.
# The lock keeps Predict and Embed from using the worker at the same time.
CONVERTER = ifc_graph.SafeConverter(timeout=120)
CONVERTER_LOCK = threading.Lock()
_CACHE = {}          # file hash -> (recon, latent, points); Embed after Predict is instant


def _file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(ifc_path):
    """IFC file -> graph (P1's code) -> ONNX -> (reconstruction, latent, input points)."""
    if not ifc_path:
        raise gr.Error("Please upload an .ifc file first.")
    key = _file_hash(ifc_path)
    if key in _CACHE:
        return _CACHE[key]
    # Convert in a separate process: some IFC files crash IfcOpenShell's C++ engine,
    # which would otherwise kill the whole server. If it crashes, a new worker starts.
    with CONVERTER_LOCK:
        status, pts, _ = CONVERTER.convert(Path(ifc_path))
    if status != "ok":
        raise gr.Error(f"Could not read the IFC geometry ({status}): {pts}")
    pts = pts.astype(np.float32)
    edge_index = ifc_graph.knn_edges(pts).astype(np.int64)
    recon, z = SESS.run(None, {"x": pts, "edge_index": edge_index})
    result = (recon.reshape(-1, 3), z[0], pts)
    if len(_CACHE) > 64:
        _CACHE.clear()
    _CACHE[key] = result
    return result


def predict(ifc_file):
    recon, _, pts = run(ifc_file)
    score = chamfer(recon[:N], pts[:N])
    return {"score": round(score, 6), "threshold": round(THR, 6), "unusual": bool(score > THR)}


def embed(ifc_file):
    _, z, _ = run(ifc_file)
    e = z / max(float(np.linalg.norm(z)), 1e-12)
    return {"latent": z.round(6).tolist(), "embedding": e.round(6).tolist()}


examples = [[str(p)] for p in sorted((MODEL_DIR / "examples").glob("*.ifc"))]

with gr.Blocks(title="IFC anomaly + embedding") as demo:
    gr.Markdown("# IFC element check\nUpload one IFC element (.ifc). "
                "**Predict** gives an anomaly score; **Embed** gives its latent vector.")
    f = gr.File(label="IFC file", file_types=[".ifc"], type="filepath")
    with gr.Row():
        b1 = gr.Button("Predict")
        b2 = gr.Button("Embed")
    out = gr.JSON(label="Result")
    b1.click(predict, f, out, api_name="predict")
    b2.click(embed, f, out, api_name="embed")
    if examples:
        gr.Examples(examples, inputs=f)

if __name__ == "__main__":
    # Start the converter worker now, so the first request does not pay the start-up time.
    CONVERTER._start()
    # Public *.gradio.live link when run on your own computer.
    # Turned off on hosting platforms (Render, Hugging Face Spaces), which already give a public URL.
    # Override with GRADIO_SHARE=0 or GRADIO_SHARE=1.
    on_host = bool(os.environ.get("RENDER") or os.environ.get("SPACE_ID"))
    share = os.environ.get("GRADIO_SHARE", "0" if on_host else "1") == "1"
    demo.launch(server_name="0.0.0.0",
                server_port=int(os.environ.get("PORT", 7860)),
                share=share)