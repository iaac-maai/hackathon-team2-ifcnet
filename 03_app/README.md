# 03_app: Wednesday

A password-protected web app on Cloudflare. Upload **one IFC element** (`.ifc`): the app sends it to our model server on Render, shows whether the element is **normal** or **unusual**, and saves every result in a database.

| | |
|---|---|
| **Live app** | https://hackathon-ifc-app.pages.dev |
| **Model server** | https://hackathon-team2-ifcnet.onrender.com (see [`02_model_server/`](../02_model_server)) |
| **Based on** | the class example `hackathon/docs/cloudflare_app/` (notebook 2, section 3) |

## How to log in

The app asks for the **team password**. It is **not in this repository**: ask a team member.

The password is checked **on the server**, never in the browser. It is stored as an encrypted Cloudflare secret (`APP_PASSWORD`). `functions/_middleware.js` runs before every request: without the right cookie you only get the login page, and the API answers `401`. The cookie holds a hash of the password, not the password.

## What it does

1. You upload an `.ifc` file (one element, max 5 MB).
2. The page sends it to `/api/predict`, a Cloudflare function.
3. The function sends the file as base64 to the model server's `analyse` endpoint (Gradio API, two calls: start a job, then read its result).
4. The model answers with an anomaly **score** (Chamfer distance between the element and its reconstruction), the **threshold** and the verdict **`unusual`** (score above the threshold). It also returns an embedding, which the app does not use.
5. The function saves one row in D1 and the page shows the verdict, the score and how many times the threshold it is.
6. **Saved results** lists the last 20 rows from D1, so they are still there after a reload.

Only the geometry is used, never the IFC class or name. The verdict is a hint, not a check: see the model's limits in [`02_model_server/README.md`](../02_model_server/README.md).

## Cloudflare services and why

| Service | Job | Why |
|---|---|---|
| **Pages** | Serves the page (`public/`) | Free, fast static hosting. A static page cannot keep secrets, so it does no checking itself. |
| **Pages Functions** | Password gate, calls the model, saves the result (`functions/`) | Runs on Cloudflare's servers, so the password stays hidden. Python models cannot run here, which is why the model lives on Render. |
| **D1** | One row per result (`schema.sql`) | Results in the browser vanish on reload and are visible to one person only. D1 keeps them for everyone. |
| **R2** | *Not used* | Cloudflare asks for a payment method to enable R2. As notebook 2 suggests in that case, we store only the results in D1, not the uploaded files. |

Table `predictions`: `id`, `created_at`, `file_name`, `score`, `threshold`, `is_anomaly` (1 = unusual).

## What happens when…

| Situation | What the app does | Where |
|---|---|---|
| **The model server is asleep** (Render free plan sleeps after 15 min) | After 5 s the page shows *"The model server is waking up. This takes about a minute"*. If there is still no answer, the function stops waiting (60 s to start, 90 s for the result) and the page says to try again in a minute. | `index.html`, `predict.js` |
| **The IFC geometry cannot be read** | The model server answers with an error; the app shows *"The model could not read this IFC file"* (422). Nothing is saved. | `predict.js` |
| **Not an `.ifc`, or larger than 5 MB** | Refused before anything is sent to the model (400 / 413). | `predict.js` |
| **Wrong password** | Back to the login page with a message. | `login.js` |
| **The page is reloaded** | The current result disappears, the saved results are read again from D1. | `index.html` |

The threshold is saved in each row, so each verdict stays consistent. Scores from different model versions are **not comparable**: if the model is retrained, old rows keep the old model's scores.

## Run it locally

Needs Node.js. From this folder:

```bash
npm install                 # installs Wrangler (version pinned in package.json)
# create .dev.vars with one line: APP_PASSWORD=<choose-a-password>   (git-ignored, never commit it)
npm run db:local            # creates the table in a local database (.wrangler/)
npm run dev                 # http://localhost:8788, calls the Render model server
```

## Deploy

Already done once; to publish code changes, only the last command is needed.

```bash
npx wrangler login
npx wrangler d1 create hackathon-ifc-db          # paste the database_id into wrangler.toml
npm run db:remote                                # creates the table online
npx wrangler pages project create hackathon-ifc-app --production-branch main
npx wrangler pages secret put APP_PASSWORD       # type the password when asked
npm run deploy                                   # uploads public/ and functions/
```

## Files

| File | What it does |
|---|---|
| `wrangler.toml` | Project name, `MODEL_URL`, `MODEL_API_NAME`, the D1 binding. No secrets. |
| `schema.sql` | The `predictions` table |
| `functions/_middleware.js` | The password gate |
| `functions/api/login.js` | Checks the password, sets the cookie |
| `functions/api/predict.js` | Validates the file, calls the model, saves the row in D1 |
| `functions/api/history.js` | The last 20 results |
| `public/index.html`, `login.html`, `style.css` | The pages |

## Diagrams vs. the real app

Diagrams are in [`diagrams/`](diagrams/): two user stories, one system diagram and the sequence diagrams.

<!-- TODO: 3 to 5 lines once the Miro diagrams are exported. Candidate differences to check:
     - no R2 in the real app (payment method), so no file storage step;
     - the function calls /analyse (base64), not /predict (file upload);
     - the "waking up" message appears after 5 s, before the model answers or times out. -->
*To be written once the diagrams are exported.*
