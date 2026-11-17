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
| **Tools** | Claude |
| **Why** | To support code debugging, understand and fix errors, understand concepts, and structure project documentation. | 
| **Where** | Monday: data preparation, model development and training, anomaly detection, model export and validation, and project documentation. |
| **How** | As a support tool to review code and solve issues, while independently running the code, reviewing outputs, and validating results. |

**Lessons learned:** 
- **A model can "work" and still learn nothing.** Our first autoencoder ended with a Sigmoid and collapsed to a blank image (validation error stuck at 0.034). Most pixels are black, so predicting "all black" is already a good guess. A linear output fixed it. Lesson: always look at the reconstructions, not only the loss number.
- **The metric must fit the problem.** With plain reconstruction error, the thin anomalies (stairs, railings) scored as *more normal* than the normal objects (AUC below 0.5), because a small object has few bright pixels to get wrong. Dividing the error by the object's size made the score fair (AUC 0.89). Lesson: understand what a number is really measuring before trusting it.
- **Bigger is not always better.** The convolutional models beat the dense ones with 7 to 22 times fewer parameters, because they look at neighbouring pixels the way a shape needs to be read. And a bigger latent (64 vs 16) made reconstructions much better but barely improved anomaly detection, since it also reconstructed the unseen classes better.
- **Good reconstruction does not mean good similarity.** Our best model finds same-class neighbours only slightly better than comparing raw pixels (0.53 vs 0.50). The autoencoder learned shape, not IFC class. A baseline showed us this; without it we would have overstated the result.
- **Split by object, not by image.** Each object has several views. Splitting by image would put views of the same object in train and test and make the results look better than they are.
- **Accuracy hides false alarms.** Because anomalies are only 6% of the test set, precision stayed low (0.47) even with a decent AUC. Lesson: report precision and recall together with AUC, and say what a false alarm costs the user.
- **Reproducibility.** Same seed and same split for every setup, cached data and saved checkpoints, and a check that ONNX gives the same output as PyTorch (differences around 1e-7) so the server behaves like the notebook.
- **Next time:** train longer (losses were still falling at 30 epochs), use more views and more than one seed, and pick the best model using validation only, keeping the test set for the very end.


## Licence
Code: MIT. Data: IFCNet (Emunds et al. 2021, arXiv 2106.09712), no licence stated, used for non-commercial academic coursework only and not re-uploaded.