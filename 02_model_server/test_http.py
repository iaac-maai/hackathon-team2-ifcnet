"""Call the model server with plain HTTP, exactly like the Cloudflare app will.

Usage (from the repo root):
    python 02_model_server/test_http.py path/to/element.ifc                       # local server
    python 02_model_server/test_http.py path/to/element.ifc https://hackathon-team2-ifcnet.onrender.com
"""
import base64
import json
import sys
import time

import requests

ifc_path = sys.argv[1]
url = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:7860"
ifc_b64 = base64.b64encode(open(ifc_path, "rb").read()).decode()

start = time.time()
# Step 1: start a job, the server answers with a ticket (event_id)
ticket = requests.post(f"{url}/gradio_api/call/analyse", json={"data": [ifc_b64]}, timeout=120)
ticket.raise_for_status()
event_id = ticket.json()["event_id"]
# Step 2: read the result of that job
stream = requests.get(f"{url}/gradio_api/call/analyse/{event_id}", timeout=120).text
if "event: complete" not in stream:
    sys.exit(f"No result: {stream[:300]}")
result = json.loads(stream.split("event: complete")[1].split("data:")[1].strip())[0]

print(f"answered in {time.time() - start:.1f} s")
print({k: v for k, v in result.items() if k != "embedding"}, "| embedding size:", len(result["embedding"]))
