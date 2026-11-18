# 02_model_server: Tuesday

The model server for our IFC graph autoencoder. Upload **one IFC element** (`.ifc`); the server turns its geometry into a graph and answers two questions:

- **`/predict`**: is this element unusual? → anomaly score, threshold and verdict
- **`/embed`**: what is it like? → latent vector, used for similarity search

| | |
|---|---|
| **Live server** | https://hackathon-team2-ifcnet.onrender.com |
| **API docs** | "Use via API" link at the bottom of the server page |
| **Model** | https://huggingface.co/iaac-maai/hackathon-team2-ifcnet-gcn |
| **Hosting** | Render, free instance, deployed from `render.yaml` at the repo root |

> The free instance sleeps when nobody uses it. The **first request can take about 50 s**; after that, a request takes a few seconds.

## How it works

```
.ifc file -> IfcOpenShell mesh -> 1,024 surface points -> unit sphere -> 16-NN graph
          -> GCN autoencoder (ONNX) -> reconstruction + 32-number latent vector
```

1. **Read the geometry.** `ifc_graph.py` (same file as `01_autoencoder/src/ifc_graph.py`) builds the triangle mesh with IfcOpenShell, samples 1,024 points on the surface, centres and scales them, and links each point to its 16 nearest points. Only geometry is used, never the IFC class, name or properties.
2. **Run the model.** `model.onnx` (graph autoencoder, exported from PyTorch) returns the rebuilt points and the latent vector. The server needs no PyTorch, only `onnxruntime`.
3. **Score.** The anomaly score is the Chamfer distance between the input points and the reconstruction. If it is above the threshold (95th percentile on normal validation elements), the element is **unusual**.

**Robustness:** a few IFC files crash IfcOpenShell's geometry engine. The conversion runs in a separate worker process, so a crash returns an error message instead of stopping the server; a new worker then starts. The worker is started once and reused, and results are cached per file, so *Embed* after *Predict* on the same file is instant.

## Endpoints

| Endpoint | Input | Output |
|---|---|---|
| `/predict` | one `.ifc` file | `{"score": <number>, "threshold": 0.039336, "unusual": false}` |
| `/embed` | one `.ifc` file | `{"latent": [32 numbers], "embedding": [32 numbers, L2-normalised]}` |

Use `embedding` for similarity search (cosine similarity = dot product of two embeddings).

## Call it from Python

```python
from gradio_client import Client, handle_file

client = Client("https://hackathon-team2-ifcnet.onrender.com")
print(client.predict(handle_file("element.ifc"), api_name="/predict"))
print(client.predict(handle_file("element.ifc"), api_name="/embed"))
```

Or run the test script (from the repo root):

```
python 02_model_server/test_local.py https://hackathon-team2-ifcnet.onrender.com path/to/element.ifc
```

## Run it locally

From the repo root, in the `hackathon` environment:

```
pip install -r 02_model_server/requirements.txt
set GRADIO_SHARE=0
python 02_model_server/app.py
```

Open http://localhost:7860. If `model/model.onnx` and `model/config.json` are missing (they are git-ignored), the server downloads them from Hugging Face. To rebuild them from the trained checkpoint instead: `python 01_autoencoder/src/export_gcn_server.py`.

On Windows, `GRADIO_SHARE=0` stops Gradio from creating a public `*.gradio.live` link (Windows Defender flags the tunnel program it downloads).

## Files

| File | What it does |
|---|---|
| `app.py` | the server: loads the model once, converts the IFC file, answers `/predict` and `/embed` |
| `ifc_graph.py` | IFC → points → kNN graph (same preprocessing as training) |
| `model/config.json` | preprocessing settings, threshold, input and output shapes |
| `model/model.onnx` | the model (git-ignored, downloaded from Hugging Face) |
| `requirements.txt` | pinned packages (no PyTorch) |
| `.python-version` | Python 3.12 |
| `test_local.py` | calls a running server with a few IFC files and prints the results |

## Limits

- The model is a first version: anomaly ROC AUC 0.53 on unseen stairs and railings (see the [model card](https://huggingface.co/iaac-maai/hackathon-team2-ifcnet-gcn) and `01_autoencoder/CONCLUSION.md`). Treat the verdict as a hint, not a check.
- One element per file. A whole building model is not split into elements yet.
- Element size is removed during preprocessing, so a wrongly scaled element can still look normal.