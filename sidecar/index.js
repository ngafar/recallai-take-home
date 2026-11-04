const RecallAiSdk = require("@recallai/desktop-sdk");

const apiUrl = process.env.RECALL_API_URL || "https://us-west-2.recall.ai";

const PERMISSIONS = ["accessibility", "microphone", "screen-capture"];

function log(event, detail) {
  console.log(`\n[${new Date().toISOString()}] ${event}`);
  if (detail !== undefined) {
    console.log(
      typeof detail === "string" ? detail : JSON.stringify(detail, null, 2),
    );
  }
}

RecallAiSdk.addEventListener("permission-status", (evt) => {
  log("permission-status", {
    permission: evt.permission,
    status: evt.status,
  });

  if (evt.status === "denied") {
    console.log(
      `macOS will not prompt again for "${evt.permission}". Enable it for the terminal or node in System Settings → Privacy & Security, then restart this script.`,
    );
  }
});

RecallAiSdk.addEventListener("permissions-granted", () => {
  log(
    "permissions-granted",
    "Every permission requested at startup is granted. Meeting detection can run.",
  );
});

RecallAiSdk.addEventListener("meeting-detected", (evt) => {
  // evt.window.id is the windowId that startRecording() will need later.
  // The URL is often missing on this event and arrives on meeting-updated.
  log("meeting-detected", evt.window);
});

RecallAiSdk.addEventListener("meeting-updated", (evt) => {
  log("meeting-updated", evt.window);
});

RecallAiSdk.addEventListener("meeting-closed", (evt) => {
  log("meeting-closed", evt.window);
});

RecallAiSdk.addEventListener("error", (evt) => {
  log("error", {
    type: evt.type,
    message: evt.message,
    windowId: evt.window?.id,
  });
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
    "Leave this process running and join a Google Meet in Chrome or Safari. This script does not record yet.",
  );
}

let shuttingDown = false;

process.on("SIGINT", () => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log("shutdown", "Stopping the SDK.");
  // Nothing is recording, so shutting down here cannot drop media.
  RecallAiSdk.shutdown()
    .catch((err) => console.error(err))
    .finally(() => process.exit(0));
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
