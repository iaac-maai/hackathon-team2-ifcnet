// POST /api/predict with a form field "ifc" (one .ifc file):
// 1. send it to the model server, 2. store the result in D1, 3. answer the page.
// No R2: Cloudflare asks for a payment method to enable it, so the file itself is not stored.

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB: 95% of the IFCNet elements are under 200 KB

export async function onRequestPost({ request, env }) {
  const form = await request.formData();
  const file = form.get("ifc");
  if (!file || typeof file === "string") {
    return Response.json({ error: "Send an .ifc file in the field 'ifc'." }, { status: 400 });
  }
  if (!file.name.toLowerCase().endsWith(".ifc")) {
    return Response.json({ error: "Only .ifc files are accepted." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: "File too large (max 5 MB)." }, { status: 413 });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());

  // 1. Ask the model
  let result;
  try {
    result = await callModel(env, toBase64(bytes));
  } catch (err) {
    if (err instanceof ModelError) {
      // The model server answered, but could not use this file (e.g. broken IFC geometry)
      return Response.json({ error: `The model could not read this IFC file. ${err.message}` }, { status: 422 });
    }
    // No answer: the free Render server was asleep (it is waking up now) or is down
    return Response.json(
      {
        error: "The model server is waking up. This takes about a minute: please try again in a minute.",
        waking: true,
        detail: String(err),
      },
      { status: 503 },
    );
  }

  // 2. Store one row in D1. The "?" placeholders keep user input out of the SQL text
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO predictions (id, created_at, file_name, score, threshold, is_anomaly) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, createdAt, file.name || null, result.score, result.threshold, result.unusual ? 1 : 0)
    .run();

  // 3. Answer the page (the embedding is not needed by the page, so it is left out)
  return Response.json({
    id,
    created_at: createdAt,
    file_name: file.name,
    score: result.score,
    threshold: result.threshold,
    unusual: result.unusual,
  });
}

// The model server answered with an error message (not a timeout or a sleeping server)
class ModelError extends Error {}

// Gradio's HTTP API has two steps: start a job, then read its result
async function callModel(env, ifcBase64) {
  const base = `${env.MODEL_URL}/gradio_api/call/${env.MODEL_API_NAME}`;
  const started = await fetchWithTimeout(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: [ifcBase64] }),
  });
  if (!started.ok) throw new Error(`Model server answered ${started.status}`);
  const { event_id } = await started.json();

  // Reading the IFC geometry can take a while on Render's free CPU: wait up to 90 s
  const stream = await fetchWithTimeout(`${base}/${event_id}`, {}, 90000);
  const text = await stream.text(); // "event: complete\ndata: [ {...} ]"  or  "event: error\ndata: {...}"

  const failed = text.split("event: error")[1];
  if (failed) {
    let message = "";
    try {
      message = JSON.parse(failed.split("data:")[1].trim()).error || "";
    } catch {
      // no readable message: keep it empty
    }
    throw new ModelError(message);
  }

  const complete = text.split("event: complete")[1];
  if (!complete) throw new Error(`No result from the model server: ${text.slice(0, 200)}`);
  const result = JSON.parse(complete.split("data:")[1].trim())[0];
  if (typeof result?.score !== "number") throw new ModelError("Unexpected answer from the model server.");
  return result; // { score, threshold, unusual, embedding }
}

async function fetchWithTimeout(url, options = {}, ms = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
