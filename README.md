# group2_hackathon: IFC object similarity

AI Methods I hackathon, IAAC MaAI, 16 to 20 November 2026.

## Team
- Bars Babila
- Samiha Abeda Nur
- Emmanuel Marquez
- Karthikeyan Seravanan

## Topic
An autoencoder trained on renders of BIM objects (IFCNet). It finds the most similar BIM objects and their IFC class.

## Setup (everyone, once)
Clone **outside** the course folder, then in the VS Code terminal:

```
conda create -n hackathon python=3.12 -y
conda activate hackathon
pip install -r 01_autoencoder/requirements.txt
pip install ipykernel
```

Download the data (about 450 MB, not on GitHub):

```
curl -L -o data/IFCNetCorePng.zip https://ifcnet.e3d.rwth-aachen.de/IFCNetCorePng.zip
tar -xf data/IFCNetCorePng.zip -C data
```

Open `01_autoencoder/notebook/autoencoder.ipynb` and pick the **hackathon** kernel (top right).

Check: `python -c "import torch, onnxruntime, onnxscript; print('ok')"`

**Rules:** never commit data, `.onnx`, `.pt` or tokens. `git pull` before you start. Small commits.

## Links
| Part | Link |
|---|---|
| Model on Hugging Face | (Monday) |
| Model server on Render | (Tuesday) |
| App on Cloudflare | (Wednesday) |
| Impulse-talk slides | see `impulse/LINK.md` |

## Folders
| Folder | Day | Status |
|---|---|---|
| `01_autoencoder/` | Monday | in progress |

## AI usage disclosure
| | |
|---|---|
| **Tools** | ... |
| **Why** | ... |
| **Where** | Monday: ... Tuesday: ... Wednesday: ... Thursday: ... |
| **How** | ... |

**Lessons learned:** ...
