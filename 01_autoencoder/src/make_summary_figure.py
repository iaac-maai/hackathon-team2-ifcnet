"""Draw figures/summary_all_models.png: all autoencoders on the same task.

The values are the final test results listed in CONCLUSION.md
(sources: comparison.csv, comparison_3d.csv, comparison_graph.csv).
No training, no data needed. Run from the repo root:
    python 01_autoencoder/src/make_summary_figure.py
"""
from pathlib import Path

import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[1]          # 01_autoencoder/
OUT = ROOT / "figures" / "summary_all_models.png"

# model: (family, ROC AUC, recall, P@5)
RESULTS = {
    "conv_64":  ("2D CNN", 0.891, 0.627, 0.534),
    "conv_16":  ("2D CNN", 0.884, 0.515, 0.507),
    "dense_64": ("2D dense", 0.810, 0.420, 0.506),
    "dense_16": ("2D dense", 0.821, 0.396, 0.496),
    "pn_64":    ("3D PointNet", 0.586, 0.308, 0.465),
    "pn_16":    ("3D PointNet", 0.585, 0.308, 0.466),
    "pn_128":   ("3D PointNet", 0.584, 0.280, 0.467),
    "gcn_32":   ("IFC graph GCN", 0.534, 0.217, 0.386),
}
COLOURS = {"2D CNN": "#2a7ad6", "2D dense": "#ea6a3a", "3D PointNet": "#1db383", "IFC graph GCN": "#e9a400"}
PANELS = [("Anomaly ROC AUC (higher = better)", 1, 0.5),
          ("Anomaly recall @ 95th-pct threshold", 2, None),
          ("Similarity P@5 (same class in top 5)", 3, 0.063)]

names = list(RESULTS)[::-1]                          # top-to-bottom order as listed
fig, axes = plt.subplots(1, 3, figsize=(16, 5.6), sharey=True)
for ax, (title, col, chance) in zip(axes, PANELS):
    values = [RESULTS[n][col] for n in names]
    colours = [COLOURS[RESULTS[n][0]] for n in names]
    ax.barh(names, values, color=colours, height=0.6)
    for y, v in enumerate(values):
        ax.text(v + 0.01, y, f"{v:.2f}", va="center", fontsize=10)
    if chance is not None:
        ax.axvline(chance, color="#333", linestyle="--", linewidth=1)
        ax.text(chance, len(names) - 0.4, "chance", ha="center", fontsize=8)
    ax.set_xlim(0, 1)
    ax.set_title(title, fontsize=12)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)

handles = [plt.Rectangle((0, 0), 1, 1, color=c) for c in COLOURS.values()]
fig.legend(handles, COLOURS.keys(), loc="lower center", ncol=4, frameon=False, fontsize=11)
fig.suptitle("All autoencoders on the same task: unseen IfcStair + IfcRailing as anomalies",
             x=0.01, ha="left", fontweight="bold", fontsize=13)
fig.tight_layout(rect=(0, 0.07, 1, 0.95))
fig.savefig(OUT, dpi=120)
print("wrote", OUT)
