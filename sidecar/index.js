const readline = require("node:readline");
const RecallAiSdk = require("@recallai/desktop-sdk");

const apiUrl = process.env.RECALL_API_URL || "https://us-west-2.recall.ai";
const uploadServerUrl = process.env.UPLOAD_SERVER_URL || "http://127.0.0.1:3000";

// The Tauri app sets this. Human-readable logs stay on stderr, and stdout is one JSON object per line.
const ipc = process.env.SDK_IPC === "1";

const PERMISSIONS = ["accessibility", "microphone", "screen-capture"];

// The latest Meet the SDK can see. Start uses this id; it does not record every detection.
let detectedWindow = null;
// Set from recording-started, cleared on recording-ended.
// startRecording() resolving only means the command was accepted, so pendingWindowId covers the gap before recording-started.
let recordingWindowId = null;
let pendingWindowId = null;

function log(event, detail) {
  const write = ipc ? console.error : console.log;
  write(`\n[${new Date().toISOString()}] ${event}`);
  if (detail !== undefined) {
    write(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
  }
}

function publish(payload) {
  if (!ipc) {
    return;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function publicWindow(meetingWindow) {
  return {
    id: meetingWindow.id,
    url: meetingWindow.url || null,
    title: meetingWindow.title || null,
    platform: meetingWindow.platform || null,
  };
}

RecallAiSdk.addEventListener("permission-status", (evt) => {
  log("permission-status", {
    permission: evt.permission,
    status: evt.status,
  });
  publish({
    event: "permission-status",
    permission: evt.permission,
    status: evt.status,
  });

  if (evt.status === "denied") {
    log(
      "permission-denied",
      `macOS will not prompt again for "${evt.permission}". Enable it for the terminal or node in System Settings → Privacy & Security, then restart this script.`,
    );
  }
});

RecallAiSdk.addEventListener("permissions-granted", () => {
  log(
    "permissions-granted",
    "Every permission requested at startup is granted. Meeting detection can run.",
  );
  publish({ event: "permissions-granted" });
});

RecallAiSdk.addEventListener("meeting-detected", (evt) => {
  detectedWindow = evt.window;
  log("meeting-detected", evt.window);
  publish({ event: "meeting-detected", window: publicWindow(evt.window) });
  log("hint", 'Type "start" to record this meeting.');
});

RecallAiSdk.addEventListener("meeting-updated", (evt) => {
  if (!detectedWindow || detectedWindow.id === evt.window.id) {
    detectedWindow = evt.window;
  }
  log("meeting-updated", evt.window);
  publish({ event: "meeting-updated", window: publicWindow(evt.window) });
});

RecallAiSdk.addEventListener("meeting-closed", (evt) => {
  log("meeting-closed", evt.window);
  publish({ event: "meeting-closed", window: publicWindow(evt.window) });
  if (detectedWindow?.id === evt.window.id) {
    detectedWindow = null;
  }
});

RecallAiSdk.addEventListener("recording-started", (evt) => {
  pendingWindowId = null;
  recordingWindowId = evt.window.id;
  log("recording-started", {
    windowId: evt.window.id,
    rawMedia: evt.rawMedia,
  });
  publish({
    event: "recording-started",
    windowId: evt.window.id,
    rawMedia: evt.rawMedia,
  });
  log("hint", 'Type "stop" to end the recording.');
});

RecallAiSdk.addEventListener("recording-ended", (evt) => {
  if (recordingWindowId === evt.window.id) {
    recordingWindowId = null;
  }
  log("recording-ended", { windowId: evt.window.id });
  publish({ event: "recording-ended", windowId: evt.window.id });
  log("hint", "Capture has stopped. The file is not ready until Recall finishes processing the upload.");
});

RecallAiSdk.addEventListener("error", (evt) => {
  const detail = {
    type: evt.type,
    message: evt.message,
    windowId: evt.window?.id,
  };
  log("error", detail);
  publish({ event: "error", ...detail });
  if (pendingWindowId && (!evt.window?.id || evt.window.id === pendingWindowId)) {
    pendingWindowId = null;
  }
});

async function main() {
  log("init", { apiUrl });

  // Passing the list here is what makes permissions-granted meaningful.
  // macOS shows a prompt for each one that has not been decided yet.
  await RecallAiSdk.init({
    apiUrl,
    acquirePermissionsOnStartup: PERMISSIONS,
  });

  log(
    "waiting",
    `Join a Google Meet in Chrome or Safari. Commands: start, stop. Upload server: ${uploadServerUrl}`,
  );
  publish({ event: "ready" });
  watchCommands();
}

async function startCapture() {
  if (pendingWindowId || recordingWindowId) {
    log("start", "A recording is already starting or in progress.");
    return;
  }
  if (!detectedWindow) {
    log("start", "No meeting detected. Join a Google Meet in Chrome or Safari first.");
    return;
  }

  const windowId = detectedWindow.id;
  pendingWindowId = windowId;
  try {
    const response = await fetch(`${uploadServerUrl}/sdk-upload`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `upload server responded ${response.status}`);
    }

    log("upload-created", { id: body.id, status: body.status });
    publish({ event: "upload-created", id: body.id, status: body.status });
    await RecallAiSdk.startRecording({
      windowId,
      uploadToken: body.upload_token,
    });
    log("start-accepted", { windowId, uploadId: body.id });
    publish({ event: "start-accepted", windowId, uploadId: body.id });
  } catch (err) {
    pendingWindowId = null;
    log("start-failed", err.message);
    publish({ event: "start-failed", message: err.message });
  }
}

async function stopCapture() {
  const windowId = recordingWindowId || pendingWindowId;
  if (!windowId) {
    log("stop", "No recording is in progress.");
    return;
  }

  try {
    await RecallAiSdk.stopRecording({ windowId });
    log("stop-accepted", { windowId });
    publish({ event: "stop-accepted", windowId });
  } catch (err) {
    log("stop-failed", err.message);
    publish({ event: "stop-failed", message: err.message });
  }
}

function watchCommands() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: ipc ? process.stderr : process.stdout,
    terminal: ipc ? false : process.stdin.isTTY,
    prompt: ipc ? "" : "> ",
  });
  if (!ipc) {
    rl.prompt();
  }

  rl.on("line", (line) => {
    const action = runCommand(line);
    if (!ipc) {
      Promise.resolve(action).finally(() => rl.prompt());
    }
  });

  rl.on("SIGINT", () => {
    shutdown();
  });
}

function runCommand(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  let command = trimmed.toLowerCase();
  if (trimmed.startsWith("{")) {
    try {
      command = String(JSON.parse(trimmed).command || "").toLowerCase();
    } catch {
      log("command", 'Expected {"command":"start"}, {"command":"stop"}, or the words start and stop.');
      return undefined;
    }
  }

  if (command === "start") {
    return startCapture();
  }
  if (command === "stop") {
    return stopCapture();
  }
  if (command === "shutdown") {
    return shutdown();
  }

  log("command", "Commands: start, stop");
  return undefined;
}

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  try {
    const windowId = recordingWindowId || pendingWindowId;
    if (windowId) {
      log("shutdown", "Stopping the active recording before the SDK exits.");
      await RecallAiSdk.stopRecording({ windowId });
    } else {
      log("shutdown", "Stopping the SDK.");
    }
    await RecallAiSdk.shutdown();
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => {
  shutdown();
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
