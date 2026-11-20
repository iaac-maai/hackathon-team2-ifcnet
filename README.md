# hackathon-team2-ifcnet: BIM Element Checker

AI Methods I hackathon · IAAC MaAI 2026/27 · 16 to 20 November 2026
Faculty: Salvador Cantuarias Brañes and Serjoscha Düring

## Team
- Bars Babila
- Samiha Abeda Nur
- Emmanuel Marquez
- Karthikeyan Saravanan

## Use case
A BIM coordinator checks a model before handover. Our autoencoder learned what 18 common types of BIM elements look like (IFCNet). It flags elements that look unusual (anomaly detection) and finds similar elements (latent space).

We built it three ways and compared them (see [`01_autoencoder/CONCLUSION.md`](01_autoencoder/CONCLUSION.md)):

| Input | Model | Anomaly ROC AUC |
|---|---|---|
| 2D renders of the element | convolutional autoencoder | 0.89 |
| 3D point cloud | PointNet autoencoder | 0.59 |
| **IFC geometry as a graph** | **graph (GCN) autoencoder** | 0.53 |

The model server uses the **graph model**, because it reads the IFC file itself instead of a picture of it. It is our first version and still the weakest on the numbers; the 2D model stays on Hugging Face as the best-scoring reference.

## Links
| Part | Link |
|---|---|
| Model server on Render (graph model) | https://hackathon-team2-ifcnet.onrender.com |
| Graph model on Hugging Face | https://huggingface.co/iaac-maai/hackathon-team2-ifcnet-gcn |
| 2D model on Hugging Face (Monday) | https://huggingface.co/iaac-maai/hackathon-team2-ifcnet-ae |
| App on Cloudflare (password) | https://hackathon-ifc-app.pages.dev |
| **Final submission (use case, diagrams, proofs, limitations)** | [`04_final/README.md`](04_final/README.md) |
| Impulse-talk slides | see `impulse/LINK.md` |

## Where we stand

- **Clear:** Our app works end to end on real IFC geometry. You upload one element, a graph autoencoder on Render gives a score and a Normal / Unusual verdict, the website finds the 5 most similar elements, and the result is saved in D1 behind a password.
- **Unclear:** Whether the score really means "unusual". On unseen stairs and railings the AUC is only 0.53, close to chance, and similar shapes are often from another IFC class (P@5 0.39). The score seems to measure how complex an element is more than how unusual it is. Our 2D image model scores much better (AUC 0.89), but it cannot read the IFC file directly.
- **Next:** A stronger graph encoder (for example EdgeConv) and longer GPU training, keeping the real size of the element, and splitting a whole building model into elements, so an architect can check a full project instead of one element per file.

## Repository structure
```
├── 01_autoencoder/       # Monday: data, notebooks (2D, point cloud, IFC graph), models, results
├── 02_model_server/      # Tuesday: Gradio server for the graph model (see its README)
├── 03_app/               # Wednesday-Thursday: Cloudflare Pages app (password, D1, similarity, 3D, house view)
├── 04_final/             # Friday: final README, diagrams, proofs
├── experiments/          # side tests (three.js renders vs IFCNet renders)
├── impulse/LINK.md       # impulse-talk slides
├── data/                 # downloaded data, not on GitHub
├── render.yaml           # Render Blueprint for the model server
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

Download the data (not on GitHub). 2D renders (about 450 MB):

```
curl -L -o data/IFCNetCorePng.zip https://ifcnet.e3d.rwth-aachen.de/IFCNetCorePng.zip
tar -xf data/IFCNetCorePng.zip -C data
```

IFC files for the graph model (unzip so that the folder is `data/IFCNetCoreIFC/`):

```
curl -L -o data/IFCNetCoreIFC.zip https://ifcnet.e3d.rwth-aachen.de/IFCNetCoreIFC.zip
tar -xf data/IFCNetCoreIFC.zip -C data
```

Open a notebook in `01_autoencoder/notebook/` and pick the **hackathon** kernel (top right). To run the model server, see [`02_model_server/README.md`](02_model_server/README.md).

**Rules:** never commit data, `.onnx`, `.pt` or tokens. `git pull` before you start.

## AI usage disclosure
| | |
|---|---|
| **Tools** | Claude (chat) and Claude Code (in VS Code) |
| **Why** | To write and debug code, get recommendations for the ML pipeline, build the app's design and code, and structure the documentation. |
| **Where** | Monday: data preparation, model development and training, anomaly detection, model export and validation, and project documentation. Tuesday: IFC-to-graph pipeline, graph autoencoder, ONNX export, model server and deployment on Render, Hugging Face model card, and documentation. Wednesday–Thursday: assistance with app development and design, pipeline suggestions, implementation steps, error review and server setup steps, documentation, and proofs. |
| **How** | The AI proposed code and options; we decided what to keep. We accepted most of the code, changed timeouts and texts after testing, paused user accounts, and rejected a faster password hash that the AI suggested because it would weaken security. |


**Lessons learned:**
- **A model can "work" and still learn nothing.** Our first autoencoder ended with a Sigmoid and collapsed to a blank image (validation error stuck at 0.034). Most pixels are black, so predicting "all black" is already a good guess. A linear output fixed it. Lesson: always look at the reconstructions, not only the loss number.
- **The metric must fit the problem.** With plain reconstruction error, the thin anomalies (stairs, railings) scored as *more normal* than the normal objects (AUC below 0.5), because a small object has few bright pixels to get wrong. Dividing the error by the object's size made the score fair (AUC 0.89). Lesson: understand what a number is really measuring before trusting it.
- **Bigger is not always better.** The convolutional models beat the dense ones with 7 to 22 times fewer parameters, because they look at neighbouring pixels the way a shape needs to be read. And a bigger latent (64 vs 16) made reconstructions much better but barely improved anomaly detection, since it also reconstructed the unseen classes better.
- **Good reconstruction does not mean good similarity.** Our best model finds same-class neighbours only slightly better than comparing raw pixels (0.53 vs 0.50). The autoencoder learned shape, not IFC class. A baseline showed us this; without it we would have overstated the result.
- **Split by object, not by image.** Each object has several views. Splitting by image would put views of the same object in train and test and make the results look better than they are.
- **Accuracy hides false alarms.** Because anomalies are only 6% of the test set, precision stayed low (0.47) even with a decent AUC. Lesson: report precision and recall together with AUC, and say what a false alarm costs the user.
- **Closer to the real data is not automatically better.** Working on the IFC geometry (point cloud, graph) is what a BIM tool needs, but our 3D models scored lower than the 2D one (AUC about 0.6 vs 0.89). Their reconstruction error mostly measures how *complex* an element is, not how *unusual*. Their latent space works better than their reconstruction error.
- **A server is more than the model.** Some IFC files crash the geometry engine, so the conversion runs in a separate worker process; the model is downloaded from Hugging Face because model files are not in git; and starting that worker once instead of per request cut a prediction on Render from about 40 seconds to a few seconds.
- **Reproducibility.** Same seed and same split for every setup, cached data and saved checkpoints, and a check that ONNX gives the same output as PyTorch so the server behaves like the notebook.
- **AI suggestions need checking against the rules.** One suggestion fixed a technical limit by making the password hash weaker. It worked, but it went against the course's security advice, so we dropped it. Lesson: ask what a "fix" costs, not only whether it works.
- **Next time:** train longer (losses were still falling at 30 epochs), use more than one seed, a stronger graph encoder, and pick the best model using validation only, keeping the test set for the very end.

## Licence
Code: MIT. Data: IFCNet (Emunds et al. 2021, arXiv 2106.09712), no licence stated, used for non-commercial academic coursework only and not re-uploaded.