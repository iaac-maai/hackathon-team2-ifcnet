# PROOFS

Four checks of the final app, run on **19 Nov 2026, 17:36 CET** against the live services.
Each proof gives the command and its output (trimmed of timing metadata), or a screenshot.

| | |
|---|---|
| App | https://hackathon-ifc-app.pages.dev (password) |
| Model server | https://hackathon-team2-ifcnet.onrender.com |
| D1 database | `hackathon-ifc-db` |

## Proof 1: a database (D1)

```
npx wrangler d1 execute hackathon-ifc-db --remote --command "SELECT name FROM sqlite_master"
```

```
🌀 Executing on remote database hackathon-ifc-db (4d4d43a6-66f2-4e2e-bfb9-14c56dbc53d0):
🚣 Executed 1 command in 0.52ms
"results": [
  { "name": "_cf_KV" },
  { "name": "predictions" },
  { "name": "sqlite_autoindex_predictions_1" },
  { "name": "idx_predictions_created_at" },
  { "name": "gallery" },
  { "name": "sqlite_autoindex_gallery_1" }
]
```

Two tables: `predictions` (one row per analysed file) and `gallery` (the 370 reference embeddings for the similarity search). `_cf_KV` is Cloudflare's own. Row counts at the same time:

```
npx wrangler d1 execute hackathon-ifc-db --remote --command "SELECT (SELECT COUNT(*) FROM predictions) AS predictions, (SELECT COUNT(*) FROM gallery) AS gallery"
```

```
"predictions": 12,
"gallery": 370
```

## Proof 2: locked on the server

Without the password cookie, the API answers `401` and no data, and the page redirects to the login.

```
curl -i https://hackathon-ifc-app.pages.dev/api/history
```

```
HTTP/2 401
content-type: application/json
content-length: 25
server: cloudflare

{"error":"Not logged in"}
```

```
curl -i -X POST https://hackathon-ifc-app.pages.dev/api/predict
```

```
HTTP/2 401
content-type: application/json
{"error":"Not logged in"}
```

```
curl -i https://hackathon-ifc-app.pages.dev/
```

```
HTTP/2 302
location: https://hackathon-ifc-app.pages.dev/login
```

The check runs in `03_app/functions/_middleware.js`, before every request, against the Cloudflare secret `APP_PASSWORD`.

## Proof 3: connected to Render

The app's function calls the model server set in `03_app/wrangler.toml`:

```
10:MODEL_URL = "https://hackathon-team2-ifcnet.onrender.com"
12:MODEL_API_NAME = "analyse"
```

A real result in the app:

![A real result in the app](proofs/proof3_result.png)

<!-- TODO: add the screenshot 04_final/proofs/proof3_result.png (a result in the live app, private window). -->

The three latest results saved in D1 carry the threshold of the model that runs on Render (0.039336, as in the model card):

```
npx wrangler d1 execute hackathon-ifc-db --remote --command "SELECT created_at, file_name, score, threshold, is_anomaly FROM predictions ORDER BY created_at DESC LIMIT 3"
```

```
2026-11-19T12:09:03Z  19f0c1f7a8ea40e5bac9625d3cdf8770.ifc  score 0.028232  threshold 0.039336  is_anomaly 0
2026-11-19T12:08:23Z  1fcff34fd9c04537a9913a0e0643359a.ifc  score 0.055149  threshold 0.039336  is_anomaly 1
2026-11-19T12:06:53Z  0a76857fb9f34f34a684aa3a716b6666.ifc  score 0.043007  threshold 0.039336  is_anomaly 1
```

## Proof 4: no secrets in git

`.dev.vars` (the local password file) is ignored, is not tracked and was never committed:

```
grep -n "dev.vars" .gitignore 03_app/.gitignore
.gitignore:37:.dev.vars
03_app/.gitignore:3:.dev.vars

git check-ignore -v 03_app/.dev.vars
03_app/.gitignore:3:.dev.vars	03_app/.dev.vars

git ls-files | grep -E "\.dev\.vars|\.env$"
(no output: no .dev.vars or .env tracked)

git log --all --oneline -- '*.dev.vars' '*.env'
(no output: never committed)
```

Files that contain the word "password": only code, comments, labels and docs, no values.

```
git grep -i -l password
03_app/README.md
03_app/functions/_middleware.js
03_app/functions/api/login.js
03_app/package.json
03_app/public/login.html
03_app/public/style.css
03_app/wrangler.toml
README.md
```

Commits that added or removed `APP_PASSWORD`, and every added line with `APP_PASSWORD=` in the whole history: only the placeholders of the docs.

```
git log --all --oneline -S"APP_PASSWORD"
3a3db33 Readme update
8fe263d 03_app addition

git log --all -p -S"APP_PASSWORD" | grep -E "^\+.*APP_PASSWORD="
+# create .dev.vars with one line: APP_PASSWORD=<choose-a-password>   (git-ignored, never commit it)
+# Local:   put APP_PASSWORD=... in a .dev.vars file (never commit it)
```

The password is given to the instructors through the course submission, not in this repository.
