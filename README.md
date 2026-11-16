# hackathon-team2-ifcnet: BIM Element Checker

AI Methods I hackathon · IAAC MaAI 2026/27 · 16 to 20 November 2026
Faculty: Salvador Cantuarias Brañes and Serjoscha Düring

## Team
- Bars Babila
- Samiha Abeda Nur
- Emmanuel Marquez
- Karthikeyan Seravanan

## Use case
A BIM coordinator checks a model before handover. Our autoencoder learned what 18 common types of BIM elements look like (IFCNet renders). It flags elements that look unusual (anomaly detection) and can find similar elements (latent space).

## Links
| Part | Link |
|---|---|
| Model on Hugging Face | https://huggingface.co/iaac-maai/hackathon-team2-ifcnet-ae |
| Model server on Render | (Tuesday) |
| App on Cloudflare | (Wednesday) |
| Impulse-talk slides | see `impulse/LINK.md` |

## Repository structure
```
├── 01_autoencoder/      # Monday: data, notebook, model, slides
├── impulse/LINK.md      # impulse-talk slides
├── data/                # downloaded data, not on GitHub
├── .gitignore
├── LICENSE
└── README.md
```

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

**Rules:** never commit data, `.onnx`, `.pt` or tokens. `git pull` before you start.

## AI usage disclosure
| | |
|---|---|
| **Tools** | ... |
| **Why** | ... |
| **Where** | Monday: ... |
| **How** | ... |

**Lessons learned:** ...

## Licence
Code: MIT. Data: IFCNet (Emunds et al. 2021, arXiv 2106.09712), no licence stated, used for non-commercial academic coursework only and not re-uploaded.