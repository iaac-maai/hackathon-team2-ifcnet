# 01_autoencoder: Monday

## Use case
We train an autoencoder on renders of 18 types of BIM elements. If it cannot rebuild an element well (high reconstruction error), the element is unusual and a person should check it. For a user, the output is a **score** and a **verdict: "typical" or "unusual object, check it"**.

## Dataset
| | |
|---|---|
| Name | IFCNet (IFCNetCore, multi-view PNG renders) |
| Source | https://ifcnet.e3d.rwth-aachen.de/ |
| Description | BIM objects in 20 IFC classes, 12 views per object |
| Used | 3 views per object, max 300 objects per class, 64 x 64 greyscale · 11,931 train / 1,986 val / 7,137 test images |
| Licence | Not stated; used for non-commercial academic coursework only, not re-uploaded |
| Cite | Emunds et al. (2021), "IFCNet: A Benchmark Dataset for IFC Entity Classification", arXiv 2106.09712 |

**Anomaly setup:** trained on 18 normal classes only. `IfcStair` and `IfcRailing` are the anomalies, unseen until the test (429 of 7,137 test images).

## How to run
1. Follow **Setup** in the root README (environment and data download).
2. Open `notebook/autoencoder.ipynb` with the `hackathon` kernel and run all cells.
3. The first run builds a cache in `data/` (about 8 minutes); later runs take seconds.

## Setups compared
Same split and seed, 30 epochs. Score = reconstruction error / object pixel mass. Threshold = 95th percentile of the score on normal validation images.

| Model | Parameters | Val MSE | Test MSE | ROC AUC | Precision | Recall |
|---|---|---|---|---|---|---|
| dense_16 | 4,334,864 | 0.00179 | 0.00180 | 0.821 | 0.399 | 0.396 |
| dense_64 | 4,347,200 | 0.00154 | 0.00154 | 0.810 | 0.391 | 0.420 |
| conv_16 | 199,745 | 0.00158 | 0.00158 | 0.884 | 0.449 | 0.515 |
| **conv_64** | 593,009 | **0.00055** | **0.00056** | **0.891** | **0.458** | **0.629** |

**Conclusion:** conv_64 is the best model: ROC AUC 0.89, and it finds 63% of the anomalies. Convolutional models beat dense ones with 7 to 22 times fewer parameters. A bigger latent lowers the reconstruction error but barely changes the AUC.

## Result
![Anomaly score: normal vs anomaly](figures/04_anomaly_hist.png)

![Input and reconstruction](figures/05_reconstructions.png)

## Model
Hugging Face: https://huggingface.co/iaac-maai/hackathon-team2-ifcnet-ae
`model_app/` holds the config and example inputs for the model server (the ONNX file is on Hugging Face).

## Limitations
- Many false alarms (precision 0.46): anomalies are only 6% of the test set.
- Only two anomaly classes, both thin objects; the score depends on object size.
- Trained on clean renders; real Revit or Rhino screenshots may look different.
- Small setup: 64 px, 3 views per object, one seed; losses were still falling at epoch 30.