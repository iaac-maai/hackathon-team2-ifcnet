"""Whole-model check: split a small IFC house into elements and score each one.

Run ONCE on your computer, from the repo root, in the hackathon environment:
    python 03_app/scripts/build_house.py 03_app/scripts/house.ifc

It writes, into 03_app/public/house/:
  house.glb          the house as a light 3D file, one node per element ("e0", "e1", ...)
  house.json         per element: name, type, score, threshold, ratio, verdict, 5 most similar gallery elements
  elements/*.ifc     each element as its own IFC file (used by "Run live analysis" on the page)

Scoring uses exactly the server's pipeline: the element is written to its own IFC file, converted with
ifc_graph.SafeConverter (1,024 surface points, seed 42, unit sphere), kNN graph, the same model.onnx,
Chamfer distance on the first 256 points, the same threshold. So the numbers match what the live server
returns for the same element file.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "02_model_server"
APP = ROOT / "03_app"
OUT = APP / "public" / "house"
sys.path.insert(0, str(SERVER))

import ifcopenshell                    # noqa: E402
import ifcopenshell.geom               # noqa: E402
import ifcopenshell.util.shape         # noqa: E402
import onnxruntime as ort              # noqa: E402
import trimesh                         # noqa: E402
import ifc_graph                       # noqa: E402  (same preprocessing as the server)

SKIP = ("IfcOpeningElement", "IfcSpace", "IfcSite", "IfcBuilding", "IfcBuildingStorey",
        "IfcAnnotation", "IfcGrid", "IfcVirtualElement")


def category(product) -> str:
    """A readable element type, only for labels and the 'colour by type' mode (never a model input)."""
    t = product.is_a()
    name = (product.Name or "").lower()
    if t.startswith("IfcWall"):
        return "Wall"
    if t == "IfcDoor":
        return "Door"
    if t == "IfcWindow" or "window" in name or "awning" in name or "casement" in name:
        return "Window"
    if t == "IfcSlab" or "floor" in name:
        return "Floor"
    if t.startswith("IfcStair") or "stair" in name or " run" in name or name.startswith("monolithic run"):
        return "Stair"
    if t == "IfcRailing" or "railing" in name or "rail" in name:
        return "Railing"
    if any(k in name for k in ("wc", "basin", "sink", "toilet", "bath", "shower", "cistern")):
        return "Sanitary"
    if t in ("IfcFurnishingElement", "IfcFurniture") or any(k in name for k in ("bed", "sofa", "table", "chair", "desk", "cabinet", "casework")):
        return "Furniture"
    return t.replace("Ifc", "") or "Element"


def chamfer(a, b):
    d = ((a[:, None, :] - b[None, :, :]) ** 2).sum(-1)
    return float(d.min(1).mean() + d.min(0).mean())


def load_gallery():
    """Rows of 03_app/gallery.sql: (object_id, ifc_class, file_name, threshold, embedding JSON)."""
    sql = (APP / "gallery.sql").read_text(encoding="utf-8")
    rows = re.findall(r"\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*([-0-9.eE]+)\s*,\s*'(\[[^\]]*\])'\s*\)", sql)
    if not rows:
        print("WARNING: no gallery rows parsed from gallery.sql; 'similar' will be empty")
        return [], np.zeros((0, 32), dtype=np.float32)
    meta = [{"ifc_class": r[1], "file_name": r[2]} for r in rows]
    emb = np.array([json.loads(r[4]) for r in rows], dtype=np.float32)
    return meta, emb


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: python 03_app/scripts/build_house.py path/to/house.ifc")
    src = Path(sys.argv[1]).resolve()
    model = ifcopenshell.open(str(src))
    (OUT / "elements").mkdir(parents=True, exist_ok=True)
    for old in (OUT / "elements").glob("*.ifc"):
        old.unlink()

    cfg = json.loads((SERVER / "model" / "config.json").read_text())
    thr = float(cfg["threshold"])
    n_score = int(cfg["score_points"])
    sess = ort.InferenceSession(str(SERVER / "model" / cfg["model_file"]), providers=["CPUExecutionProvider"])
    g_meta, g_emb = load_gallery()

    products = [p for p in model.by_type("IfcProduct")
                if p.Representation is not None and not any(p.is_a(s) for s in SKIP)]
    print(f"{len(products)} elements with geometry in {src.name}")

    # 1) the 3D file: one mesh per element, world coordinates in metres, z up (openings cut into the walls)
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    index_of = {p.GlobalId: i for i, p in enumerate(products)}
    scene = trimesh.Scene()
    has_mesh = set()
    for p in products:
        try:
            shape = ifcopenshell.geom.create_shape(settings, p)
            v = ifcopenshell.util.shape.get_vertices(shape.geometry)
            f = ifcopenshell.util.shape.get_faces(shape.geometry)
            if len(v) and len(f):
                i = index_of[p.GlobalId]
                mesh = trimesh.Trimesh(vertices=v, faces=f, process=True)
                scene.add_geometry(mesh, node_name=f"e{i}", geom_name=f"e{i}")
                has_mesh.add(i)
        except Exception as e:  # one bad element must not stop the house
            print(f"  mesh skipped for {p.is_a()} {p.Name}: {type(e).__name__}: {e}")
    scene.export(str(OUT / "house.glb"))
    print(f"wrote house.glb with {len(has_mesh)} meshes")

    # 2) each element as its own IFC file, scored exactly like the server does
    elements = []
    counters = {}
    with ifc_graph.SafeConverter(timeout=120) as conv:
        for i, p in enumerate(products):
            cat = category(p)
            counters[cat] = counters.get(cat, 0) + 1
            fname = f"house_{cat.lower()}_{counters[cat]:02d}.ifc"
            path = OUT / "elements" / fname
            sub = ifcopenshell.file(schema=model.schema)
            for proj in model.by_type("IfcProject"):
                sub.add(proj)       # project + units (mm) + representation contexts
            sub.add(p)              # the element with its placement and geometry (not its openings)
            sub.write(str(path))

            item = {"idx": i, "name": p.Name or p.is_a(), "ifc_type": p.is_a(), "category": cat,
                    "file": f"elements/{fname}", "has_mesh": i in has_mesh, "threshold": round(thr, 6)}
            status, pts, _ = conv.convert(path)
            if status != "ok":
                item.update(status=status, message=str(pts)[:200])
                print(f"  {i:3d} {cat:9s} {status}: {str(pts)[:80]}")
                elements.append(item)
                continue
            pts = pts.astype(np.float32)
            edges = ifc_graph.knn_edges(pts).astype(np.int64)
            recon, z = sess.run(None, {"x": pts, "edge_index": edges})
            recon = recon.reshape(-1, 3)
            score = chamfer(recon[:n_score], pts[:n_score])
            e = z[0] / max(float(np.linalg.norm(z[0])), 1e-12)
            similar = []
            if len(g_emb):
                sims = g_emb @ e
                for j in np.argsort(-sims)[:5]:
                    similar.append({**g_meta[j], "similarity": round(float(sims[j]), 3)})
            item.update(status="ok", score=round(score, 6), ratio=round(score / thr, 3),
                        unusual=bool(score > thr), similar=similar)
            elements.append(item)
            print(f"  {i:3d} {cat:9s} score {score:.4f}  {score / thr:5.2f}x  {'UNUSUAL' if score > thr else 'ok'}")

    ok = [e for e in elements if e["status"] == "ok"]
    summary = {
        "source": src.name,
        "threshold": round(thr, 6),
        "elements": len(elements),
        "scored": len(ok),
        "unusual": sum(e["unusual"] for e in ok),
        "borderline": sum((not e["unusual"]) and e["ratio"] >= 0.8 for e in ok),
        "note": "Precomputed with the same model and preprocessing as the live server; "
                "each element is checked on its own, as a separate IFC file.",
    }
    (OUT / "house.json").write_text(json.dumps({"summary": summary, "elements": elements}, indent=1), encoding="utf-8")
    print(f"wrote house.json: {summary['scored']}/{summary['elements']} scored, "
          f"{summary['unusual']} unusual, {summary['borderline']} borderline")


if __name__ == "__main__":
    main()
