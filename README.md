# Meeting recorder

A small macOS app that records a Google Meet from the computer it is running on. No bot joins the call. The Tauri window starts and stops the recording, and a webhook tells the app when Recall has finished processing the file.

Development mode is enough. This repo does not build a packaged `.app`.

## What is running

Three processes:

| Process | Directory | Role |
| --- | --- | --- |
| Upload server | `server/` | Holds the Recall API key. Creates an upload token. Receives webhooks and stores the download URL. |
| Node sidecar | `sidecar/` | Loads `@recallai/desktop-sdk`, asks for macOS permission, and calls `startRecording` / `stopRecording`. |
| Tauri window | `desktop/` | Start, Stop, and the link to the finished recording. Spawns the sidecar. |

The window never sees the API key. It writes `{"command":"start"}` or `{"command":"stop"}` to the sidecar. The sidecar asks the server for a one-recording upload token, then passes that token to the SDK. After capture stops, Recall processes the upload and sends `sdk_upload.complete` to the server. The window polls `GET /recordings` until a download URL is there.

## Prerequisites

- Apple Silicon Mac, macOS 13 or later. The Desktop Recording SDK does not support Intel Macs.
- [Node.js](https://nodejs.org/) 18 or later. Use the official installer. Homebrew's Node is not suitable for a packaged app, and this repo runs the system `node` in dev.
- [Rust](https://rustup.rs/), including `cargo` on your `PATH`.
- Xcode Command Line Tools.
- An [ngrok](https://ngrok.com/) account. Recall has to reach the webhook from the internet.
- A Recall API key for the same region as `RECALL_API_URL`.
- Google Meet in Chrome or Safari. The installed Meet app is not supported.

## Setup

```bash
npm install --prefix sidecar
npm install --prefix desktop
cp server/.env.example server/.env
```

`npm install` in `sidecar/` downloads the SDK's native macOS binary into `node_modules`. That directory is gitignored.

Fill in `server/.env`:

- `RECALL_API_URL` is the base URL for the workspace region. The default is US pay-as-you-go, `https://us-west-2.recall.ai`.
- `RECALL_API_KEY` comes from the API keys page for that region.
- `RECALL_WEBHOOK_SECRET` is the workspace verification secret from the same page. It starts with `whsec_`. Recall only signs webhooks after this secret exists.

Start the server, then start a tunnel:

```bash
npm start --prefix server
ngrok http 3000
```

In the Recall dashboard for that same region, add a webhook endpoint:

`https://<ngrok-host>/webhook`

Subscribe it to:

- `sdk_upload.complete`
- `sdk_upload.failed`
- `sdk_upload.recording_started`
- `sdk_upload.recording_ended`

Restart the server after changing `server/.env`. Leave the server and ngrok running.

## Run the app

Do not also run `npm start` in `sidecar/`. The Tauri app starts that process itself, and two copies will both try to detect the same meeting.

```bash
cd desktop
npm run tauri dev
```

If this terminal was open before Rust was installed, `cargo` will be missing until you load it:

```bash
source "$HOME/.cargo/env"
```

Join a Google Meet. When the window says the meeting is open, press Start, talk for a few seconds, then press Stop. The recordings list follows the webhook from uploading to ready. Open plays the file. The download URL is temporary.

macOS may ask for microphone, accessibility, and screen recording. Those prompts can attach to `node` or to the `desktop` dev app. If a permission was already denied, turn it on under System Settings, Privacy & Security, then restart the app. macOS will not show the prompt again.

## How one recording moves

1. The SDK emits `meeting-detected` with a `window.id`. That id is the meeting window, not a permission to upload.
2. Start asks `POST /sdk-upload` on the local server.
3. The server calls `POST /api/v1/sdk_upload/` with the API key and returns an `upload_token`.
4. The sidecar calls `startRecording({ windowId, uploadToken })`.
5. `recording-started` means capture has begun. `rawMedia: false` means the SDK recorded the Meet window locally, which is a successful recording.
6. Stop calls `stopRecording`. `recording-ended` means capture stopped. The file is not ready yet.
7. Recall sends `sdk_upload.complete`. The server checks the webhook signature, then calls `GET /api/v1/recording/{id}` and keeps `media_shortcuts.video_mixed.data.download_url`.

Creating an upload does not start capture. Each press of Start creates a new upload. An upload that never starts recording can stay in processing in the Recall dashboard.

## When something fails

- `cargo metadata` fails with `os error 2`: this shell does not have `~/.cargo/bin` on `PATH`. Run `source "$HOME/.cargo/env"`.
- `POST /sdk-upload` returns 401: the API key or region does not match the workspace.
- The webhook log says the signature does not match: `RECALL_WEBHOOK_SECRET` is wrong, or the server was not restarted after it was set.
- No webhook arrives: ngrok is not running, or the dashboard endpoint is not the current ngrok URL. The URL changes each time ngrok restarts on a free plan.
- The meeting is never detected: use Chrome or Safari, not the Meet app, and confirm accessibility permission is granted.
- Start is disabled: the SDK has not emitted `meeting-detected` yet, or a required permission is still denied.
