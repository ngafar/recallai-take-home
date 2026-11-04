const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const REQUIRED_PERMISSIONS = ["accessibility", "microphone", "screen-capture"];
const RECORDINGS_URL = "http://127.0.0.1:3000/recordings";

const statusEl = document.querySelector("#status");
const meetingEl = document.querySelector("#meeting");
const resultEl = document.querySelector("#result");
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");

const permissions = {};
let meeting = null;
let phase = "starting";
let uploadId = null;
let downloadUrl = null;
let message = "";

startButton.addEventListener("click", () => {
  phase = "starting-recording";
  message = "";
  render();
  invoke("start_recording").catch((err) => {
    phase = meeting ? "detected" : "waiting";
    message = String(err);
    render();
  });
});

stopButton.addEventListener("click", () => {
  invoke("stop_recording").catch((err) => {
    message = String(err);
    render();
  });
});

async function boot() {
  await listen("sdk", (event) => {
    take(event.payload);
  });
  const events = await invoke("sdk_events");
  for (const event of events) take(event);
}

boot().catch((err) => {
  message = String(err);
  render();
});

setInterval(refreshRecordings, 2000);

const seen = new Set();

function take(event) {
  if (!event || seen.has(event.seq)) {
    return;
  }
  seen.add(event.seq);
  onSdk(event.payload);
}

function onSdk(payload) {
  switch (payload.event) {
    case "ready":
      if (phase === "starting") {
        phase = "waiting";
      }
      break;
    case "permission-status":
      permissions[payload.permission] = payload.status;
      break;
    case "meeting-detected":
    case "meeting-updated":
      meeting = payload.window;
      if (phase === "waiting" || phase === "detected" || phase === "starting") {
        phase = "detected";
      }
      break;
    case "meeting-closed":
      if (meeting?.id === payload.window?.id && phase !== "recording" && phase !== "processing") {
        meeting = null;
        phase = "waiting";
      }
      break;
    case "upload-created":
      uploadId = payload.id;
      downloadUrl = null;
      break;
    case "start-accepted":
      uploadId = payload.uploadId;
      phase = "starting-recording";
      break;
    case "recording-started":
      phase = "recording";
      message = "";
      break;
    case "recording-ended":
      phase = "processing";
      break;
    case "start-failed":
    case "stop-failed":
    case "error":
      message = payload.message || "The recorder reported an error.";
      if (phase === "starting-recording") {
        phase = meeting ? "detected" : "waiting";
      }
      break;
    default:
      break;
  }
  render();
}

async function refreshRecordings() {
  if (!uploadId) {
    return;
  }
  try {
    const response = await fetch(RECORDINGS_URL);
    if (!response.ok) {
      return;
    }
    const body = await response.json();
    const match = (body.recordings || []).find((recording) => recording.uploadId === uploadId);
    if (match?.downloadUrl && match.downloadUrl !== downloadUrl) {
      downloadUrl = match.downloadUrl;
      phase = "ready";
      message = "";
      render();
    }
  } catch {
    // The upload server is not reachable yet. The status line covers that once recording has ended.
  }
}

function render() {
  const denied = REQUIRED_PERMISSIONS.find((permission) => permissions[permission] === "denied");
  const granted = REQUIRED_PERMISSIONS.every((permission) => permissions[permission] === "granted");

  if (denied) {
    statusEl.textContent = `macOS denied ${denied}. Turn it on for node in System Settings → Privacy & Security, then reopen the app.`;
  } else if (!granted && phase === "starting") {
    statusEl.textContent = "Starting the recorder…";
  } else if (!granted) {
    statusEl.textContent = "Allow microphone, accessibility, and screen recording.";
  } else if (message) {
    statusEl.textContent = message;
  } else if (phase === "recording") {
    statusEl.textContent = "Recording.";
  } else if (phase === "starting-recording") {
    statusEl.textContent = "Starting the recording…";
  } else if (phase === "processing") {
    statusEl.textContent = "Processing the recording. This finishes when Recall sends the webhook.";
  } else if (phase === "ready") {
    statusEl.textContent = "Recording is ready.";
  } else if (meeting) {
    statusEl.textContent = "Google Meet is open.";
  } else {
    statusEl.textContent = "Join a Google Meet in Chrome or Safari.";
  }

  meetingEl.textContent = meeting?.url || "";

  const canStart = granted && meeting && (phase === "detected" || phase === "waiting" || phase === "ready");
  const canStop = phase === "recording" || phase === "starting-recording";
  startButton.disabled = !canStart;
  stopButton.disabled = !canStop;

  resultEl.replaceChildren();
  if (downloadUrl) {
    const link = document.createElement("button");
    link.type = "button";
    link.textContent = "Open recording";
    link.addEventListener("click", () => {
      const opener = window.__TAURI__?.opener;
      if (opener?.openUrl) {
        opener.openUrl(downloadUrl);
      }
    });
    resultEl.append(link);
  }
}
