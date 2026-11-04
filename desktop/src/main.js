const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const REQUIRED_PERMISSIONS = ["accessibility", "microphone", "screen-capture"];
const RECORDINGS_URL = "http://127.0.0.1:3000/recordings";

const statusEl = document.querySelector("#status");
const meetingEl = document.querySelector("#meeting");
const recordingsEl = document.querySelector("#recordings");
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");

const permissions = {};
let meeting = null;
let phase = "starting";
let uploadId = null;
let recordings = [];
let recordingsError = "";
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
  try {
    const response = await fetch(RECORDINGS_URL);
    if (!response.ok) {
      recordingsError = "The upload server did not return recordings.";
      render();
      return;
    }
    const body = await response.json();
    recordings = body.recordings || [];
    recordingsError = "";
    const current = recordings.find((recording) => recording.uploadId === uploadId);
    if (current?.downloadUrl) {
      phase = "ready";
      message = "";
    } else if (current?.status === "failed") {
      phase = "failed";
      message = "";
    }
    render();
  } catch {
    recordingsError = "The upload server is not running.";
    render();
  }
}

function recordingLabel(recording) {
  if (recording.downloadUrl) {
    return "Ready";
  }
  if (recording.status === "failed") {
    return "Failed";
  }
  if (recording.status === "complete") {
    return "Processing";
  }
  if (recording.status === "recording_ended" || recording.status === "uploading") {
    return "Uploading";
  }
  if (recording.status === "recording_started") {
    return "Recording";
  }
  if (recording.status === "pending") {
    return "Waiting to start";
  }
  return "Unknown";
}

async function openRecording(url) {
  try {
    await window.__TAURI__.opener.openUrl(url);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
    render();
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
    statusEl.textContent = currentLabel() || "Processing the recording.";
  } else if (phase === "ready") {
    statusEl.textContent = "Recording is ready.";
  } else if (phase === "failed") {
    statusEl.textContent = "The recording failed.";
  } else if (meeting) {
    statusEl.textContent = "Google Meet is open.";
  } else {
    statusEl.textContent = "Join a Google Meet in Chrome or Safari.";
  }

  meetingEl.textContent = meeting?.url || "";

  const canStart =
    granted &&
    meeting &&
    (phase === "detected" || phase === "waiting" || phase === "ready" || phase === "failed");
  const canStop = phase === "recording" || phase === "starting-recording";
  startButton.disabled = !canStart;
  stopButton.disabled = !canStop;

  renderRecordings();
}

function currentLabel() {
  const current = recordings.find((recording) => recording.uploadId === uploadId);
  return current ? recordingLabel(current) : "";
}

function renderRecordings() {
  recordingsEl.replaceChildren();
  if (recordingsError) {
    recordingsEl.append(note(recordingsError));
    return;
  }
  if (recordings.length === 0) {
    recordingsEl.append(note("No recordings yet."));
    return;
  }

  for (const recording of recordings) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${recordingLabel(recording)} · ${recording.uploadId.slice(0, 8)}`;
    item.append(label);
    if (recording.downloadUrl) {
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = "Open";
      open.addEventListener("click", () => openRecording(recording.downloadUrl));
      item.append(open);
    }
    recordingsEl.append(item);
  }
}

function note(text) {
  const item = document.createElement("li");
  item.className = "empty";
  item.textContent = text;
  return item;
}
