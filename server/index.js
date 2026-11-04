const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { verifyWebhook } = require("./verify");

loadEnv(path.join(__dirname, ".env"));

const port = Number(process.env.PORT || 3000);
const apiUrl = (process.env.RECALL_API_URL || "https://us-west-2.recall.ai").replace(/\/$/, "");
const apiKey = process.env.RECALL_API_KEY;
const webhookSecret = process.env.RECALL_WEBHOOK_SECRET;

// Uploads this process has created or heard about. Restarting the server clears it.
const recordings = new Map();

function authorizationHeader(key) {
  return key.startsWith("Token ") ? key : `Token ${key}`;
}

function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

async function createSdkUpload() {
  // An empty body uses Recall's defaults: meeting video plus participant events.
  // This creates a placeholder upload. Capture starts only when the SDK calls startRecording.
  const response = await fetch(`${apiUrl}/api/v1/sdk_upload/`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: authorizationHeader(apiKey),
    },
    body: JSON.stringify({}),
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const error = new Error(`Recall responded ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }

  return data;
}

async function getRecording(recordingId) {
  const response = await fetch(`${apiUrl}/api/v1/recording/${recordingId}`, {
    headers: {
      accept: "application/json",
      authorization: authorizationHeader(apiKey),
    },
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const error = new Error(`Recall responded ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }

  return data;
}

function remember(uploadId, patch) {
  const current = recordings.get(uploadId) || { uploadId };
  const next = { ...current, ...patch, uploadId };
  recordings.set(uploadId, next);
  return next;
}

function listRecordings() {
  return [...recordings.values()].reverse();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/sdk-upload") {
    if (!apiKey) {
      send(res, 500, {
        error: "RECALL_API_KEY is not set. Copy server/.env.example to server/.env and add a key.",
      });
      return;
    }

    try {
      const upload = await createSdkUpload();
      // Log the id only. upload_token is a credential for this one recording.
      console.log(`created sdk upload ${upload.id}`);
      remember(upload.id, {
        status: upload.status?.code || "pending",
        recordingId: upload.recording_id || null,
        downloadUrl: null,
      });
      send(res, 201, {
        id: upload.id,
        upload_token: upload.upload_token,
        status: upload.status,
      });
    } catch (err) {
      console.error(err.body || err.message);
      send(res, err.status || 502, {
        error: err.message,
        recall: err.body,
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/recordings") {
    // The Tauri window is a different origin from this server, so the browser fetch needs this header.
    send(res, 200, { recordings: listRecordings() }, { "access-control-allow-origin": "*" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/webhook") {
    const rawBody = await readBody(req);
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : value || "";
    }

    try {
      verifyWebhook(webhookSecret, headers, rawBody);
    } catch (err) {
      console.error(`rejected webhook: ${err.message}`);
      send(res, 400, { error: err.message });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      send(res, 400, { error: "Webhook body is not JSON" });
      return;
    }

    try {
      const recording = await handleWebhook(payload);
      send(res, 200, { ok: true, recording });
    } catch (err) {
      console.error(err.body || err.message);
      send(res, 500, { error: err.message });
    }
    return;
  }

  send(res, 404, { error: "not found" });
});

async function handleWebhook(payload) {
  const event = payload.event;
  const uploadId = payload.data?.sdk_upload?.id;
  const recordingId = payload.data?.recording?.id;
  const status = payload.data?.data?.code;

  if (!event || !uploadId) {
    console.log(`ignored webhook ${event || "without an event name"}`);
    return null;
  }

  const saved = remember(uploadId, { status, recordingId, event });
  console.log(`${event} upload ${uploadId} recording ${recordingId || "none"}`);

  if (event !== "sdk_upload.complete" || !recordingId) {
    return saved;
  }

  const recording = await getRecording(recordingId);
  const video = recording.media_shortcuts?.video_mixed;
  const downloadUrl = video?.data?.download_url || null;
  const ready = remember(uploadId, {
    status: "complete",
    recordingId,
    videoStatus: video?.status?.code || null,
    downloadUrl,
  });

  if (downloadUrl) {
    console.log(`recording ready ${recordingId}`);
    console.log(downloadUrl);
  } else {
    console.log(`upload complete, video status ${ready.videoStatus || "missing"}`);
  }

  return ready;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

server.listen(port, () => {
  console.log(`upload server listening on http://127.0.0.1:${port}`);
  console.log(`Recall region ${apiUrl}`);
  console.log("Webhook endpoint POST /webhook");
  if (!apiKey) {
    console.log("RECALL_API_KEY is not set. POST /sdk-upload will fail until server/.env has one.");
  }
  if (!webhookSecret) {
    console.log("RECALL_WEBHOOK_SECRET is not set. POST /webhook will reject every event.");
  }
});

function loadEnv(file) {
  if (!fs.existsSync(file)) {
    return;
  }

  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
