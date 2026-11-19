"""Build browser point previews and 22 local IFC examples (one per class + an extra stair and railing).

Run from the repository root after installing the model server's Python dependencies:
    python 03_app/scripts/build_gallery_points.py
"""
from __future__ import annotations

import json
import random
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "03_app"
IFC_ROOT = ROOT / "data" / "IFCNetCoreIFC"
MODEL_DIR = ROOT / "02_model_server"
sys.path.insert(0, str(MODEL_DIR))
from ifc_graph import SafeConverter  # noqa: E402


def gallery_rows():
    sql = (APP / "gallery.sql").read_text(encoding="utf-8")
    # Gallery inserts have the form: INSERT INTO gallery VALUES ('id', 'class', 'name.ifc', ...)
    pattern = re.compile(r"INSERT INTO gallery VALUES\s*\(\s*'[^']*'\s*,\s*'([^']+)'\s*,\s*'([^']+\.ifc)'", re.I)
    return [(ifc_class, file_name) for ifc_class, file_name in pattern.findall(sql)]


def main():
    rows = gallery_rows()
    if not rows:
        raise SystemExit(f"No gallery rows found in {APP / 'gallery.sql'}")
    source_map = {path.name: path for path in IFC_ROOT.rglob("*.ifc")} if IFC_ROOT.exists() else {}
    if not source_map:
        raise SystemExit(f"No IFC files found under {IFC_ROOT}")

    points_by_file: dict[str, list[list[float]]] = {}
    classes_by_file: dict[str, str] = {}
    failures = []
    # A single SafeConverter isolates each conversion from native geometry crashes.
    with SafeConverter(timeout=120, n_points=1024, seed=42) as converter:
        for ifc_class, file_name in rows:
            path = source_map.get(file_name)
            if path is None:
                failures.append((file_name, "file not found"))
                continue
            status, points, detail = converter.convert(path)
            if status != "ok":
                failures.append((file_name, f"{status}: {points}"))
                print(f"SKIP {file_name}: {status}: {points}")
                continue
            points_by_file[file_name] = [[round(float(v), 3) for v in point] for point in points[:256]]
            classes_by_file[file_name] = ifc_class

    public = APP / "public"
    (public / "gallery_points.json").write_text(json.dumps(points_by_file, separators=(",", ":")), encoding="utf-8")

    # Pick one converted example from EACH class, plus one extra stair and one
    # extra railing (the two classes never seen in training), so 20 + 2 = 22.
    # Selection is repeatable (seed 42) and only uses files that converted.
    candidates: dict[str, list[str]] = {}
    for ifc_class, file_name in rows:
        if file_name in points_by_file:
            candidates.setdefault(ifc_class, []).append(file_name)
    rng = random.Random(42)
    chosen: list[str] = []
    special_counts = {"IfcStair": 2, "IfcRailing": 2}
    target = 22
    # Seen-in-training classes first (alphabetical), the never-seen ones last
    order = [name for name in sorted(candidates) if name not in special_counts] + list(special_counts)
    for ifc_class in order:
        pool = sorted(set(candidates.get(ifc_class, [])))
        rng.shuffle(pool)
        take = special_counts.get(ifc_class, 1)
        if len(pool) < take:
            print(f"Only {len(pool)} converted file(s) for {ifc_class}; wanted {take}.")
        chosen.extend(pool[:take])
    if len(chosen) < target:
        print(f"Only {len(chosen)} examples could be selected; {target} converted examples with the requested class mix were not available.")

    examples_dir = public / "examples"
    examples_dir.mkdir(parents=True, exist_ok=True)
    examples = []
    for file_name in chosen[:target]:
        shutil.copy2(source_map[file_name], examples_dir / file_name)
        examples.append({"file": file_name, "label": classes_by_file[file_name], "points": points_by_file[file_name]})
    (examples_dir / "examples.json").write_text(json.dumps(examples, separators=(",", ":")), encoding="utf-8")
    for file_name, message in failures:
        if "file not found" in message:
            print(f"SKIP {file_name}: {message}")
    print(f"Wrote {len(points_by_file)} gallery elements and {len(examples)} examples; {len(failures)} conversion/source failures.")


if __name__ == "__main__":
    main()
