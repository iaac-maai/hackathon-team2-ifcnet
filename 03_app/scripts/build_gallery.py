"""Build the similarity gallery for the app, through the SAME model server API the app uses.

For N test elements per IFC class, it sends the .ifc file to the Render server's `analyse`
endpoint (the one the Cloudflare app calls), keeps the 32-number embedding and writes
`gallery.sql`, which fills the D1 table `gallery`.

Run it again whenever the model on Render changes: the gallery must come from the same model.

Usage (from the repo root, needs only the Python standard library):
    python 03_app/scripts/build_gallery.py                 # 20 per class
    python 03_app/scripts/build_gallery.py --per-class 1   # quick test
Then load it:
    cd 03_app && npx wrangler d1 execute hackathon-ifc-db --local --file=gallery.sql
"""
import argparse
import base64
import csv
import json
import random
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SPLIT_CSV = REPO / "01_autoencoder/splits/ifc_split.csv"     # object_id, ifc_class, split, path
FAILURES_CSV = REPO / "data/ifc_graphs/failures.csv"          # files IfcOpenShell cannot read
DATA_DIR = REPO / "data"
APP_DIR = REPO / "03_app"
CACHE = APP_DIR / ".gallery_cache.jsonl"                     # one line per finished file (git-ignored)


def call_analyse(url, ifc_path, timeout=150):
    """Same two-step Gradio call as functions/api/predict.js."""
    base = f"{url}/gradio_api/call/analyse"
    body = json.dumps({"data": [base64.b64encode(ifc_path.read_bytes()).decode()]}).encode()
    request = urllib.request.Request(base, body, {"Content-Type": "application/json"})
    event_id = json.load(urllib.request.urlopen(request, timeout=timeout))["event_id"]
    text = urllib.request.urlopen(f"{base}/{event_id}", timeout=timeout).read().decode()
    if "event: error" in text:
        raise ValueError(text.split("event: error", 1)[1].split("data:", 1)[-1].strip()[:200])
    return json.loads(text.split("event: complete", 1)[1].split("data:", 1)[1].strip())[0]


def pick_elements(per_class, seed):
    """N random test elements per class, leaving out the files known to fail."""
    failed = set()
    if FAILURES_CSV.is_file():
        failed = {row["object_id"] for row in csv.DictReader(FAILURES_CSV.open())}
    by_class = {}
    for row in csv.DictReader(SPLIT_CSV.open()):
        if row["split"] == "test" and row["object_id"] not in failed:
            by_class.setdefault(row["ifc_class"], []).append(row)
    rng = random.Random(seed)
    chosen = []
    for ifc_class in sorted(by_class):
        rows = sorted(by_class[ifc_class], key=lambda r: r["object_id"])
        rng.shuffle(rows)
        chosen += rows[:per_class]
    return chosen


def sql_text(value):
    return "'" + str(value).replace("'", "''") + "'"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--per-class", type=int, default=20)
    parser.add_argument("--url", default="https://hackathon-team2-ifcnet.onrender.com")
    parser.add_argument("--pause", type=float, default=0.5, help="seconds between calls, to be kind to the free server")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--out", default=str(APP_DIR / "gallery.sql"))
    args = parser.parse_args()

    elements = pick_elements(args.per_class, args.seed)
    done = {}
    if CACHE.is_file():
        for line in CACHE.read_text().splitlines():
            item = json.loads(line)
            done[item["object_id"]] = item
    print(f"{len(elements)} elements, {sum(e['object_id'] in done for e in elements)} already in the cache")

    errors = []
    with CACHE.open("a") as cache:
        for i, row in enumerate(elements, 1):
            if row["object_id"] in done:
                continue
            path = DATA_DIR / row["path"]
            for attempt in (1, 2):          # one retry: the first call may hit a sleeping server
                try:
                    result = call_analyse(args.url, path)
                    break
                except ValueError as exc:    # the server answered with an error: don't retry
                    result = None
                    errors.append((row["object_id"], str(exc)))
                    break
                except Exception as exc:     # timeout / network: wait and retry once
                    result = None
                    if attempt == 2:
                        errors.append((row["object_id"], repr(exc)))
                    else:
                        time.sleep(30)
            if result:
                item = {"object_id": row["object_id"], "ifc_class": row["ifc_class"],
                        "file_name": path.name, "threshold": result["threshold"],
                        "embedding": result["embedding"]}
                done[row["object_id"]] = item
                cache.write(json.dumps(item) + "\n")
                cache.flush()
            print(f"[{i}/{len(elements)}] {row['ifc_class']:<24} {'ok' if result else 'FAILED'}", flush=True)
            time.sleep(args.pause)

    items = [done[e["object_id"]] for e in elements if e["object_id"] in done]
    thresholds = {round(item["threshold"], 6) for item in items}
    if len(thresholds) > 1:
        print(f"WARNING: the model changed during the run (thresholds {sorted(thresholds)}). "
              f"Delete {CACHE.name} and run again.")

    lines = [
        "-- Similarity gallery, made by scripts/build_gallery.py through the model server's `analyse` API.",
        "-- threshold = the model's threshold when the embedding was made (tells which model version it came from).",
        "CREATE TABLE IF NOT EXISTS gallery (",
        "  object_id  TEXT PRIMARY KEY,   -- IFCNet object id",
        "  ifc_class  TEXT NOT NULL,      -- IFC class (only for showing results; the model never sees it)",
        "  file_name  TEXT NOT NULL,",
        "  threshold  REAL NOT NULL,",
        "  embedding  TEXT NOT NULL       -- JSON list of 32 numbers, L2-normalised",
        ");",
        "DELETE FROM gallery;",
    ]
    for item in items:
        values = [sql_text(item["object_id"]), sql_text(item["ifc_class"]), sql_text(item["file_name"]),
                  repr(float(item["threshold"])), sql_text(json.dumps(item["embedding"]))]
        lines.append(f"INSERT INTO gallery VALUES ({', '.join(values)});")
    Path(args.out).write_text("\n".join(lines) + "\n")

    print(f"\nwrote {len(items)} rows to {args.out}; {len(errors)} failed")
    for object_id, message in errors:
        print(f"  {object_id}: {message}")


if __name__ == "__main__":
    main()
