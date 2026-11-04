const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

loadEnv(path.join(__dirname, ".env"));

const port = Number(process.env.PORT || 3000);
const apiUrl = (process.env.RECALL_API_URL || "https://us-west-2.recall.ai").replace(/\/$/, "");
const apiKey = process.env.RECALL_API_KEY;

function authorizationHeader(key) {
  return key.startsWith("Token ") ? key : `Token ${key}`;
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
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

  send(res, 404, { error: "not found" });
});

server.listen(port, () => {
  console.log(`upload server listening on http://127.0.0.1:${port}`);
  console.log(`Recall region ${apiUrl}`);
  if (!apiKey) {
    console.log("RECALL_API_KEY is not set. POST /sdk-upload will fail until server/.env has one.");
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
