# Botless Google Meet recorder

This example demonstrates how to record a Google Meet call without having a bot in the meeting.

## Prerequisites

- [ngrok](https://ngrok.com/)
- [Node.js](https://nodejs.org/en/download)
- [npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [Rust](https://rustup.rs/), including `cargo` on your `PATH`.

Additionally, a [Recall.ai](https://recall.ai/) API key is needed.

## Quickstart

### 1. Install dependencies 

Using npm, install the required dependencies:

```sh
npm install --prefix sidecar
npm install --prefix desktop
```

### 2. Setup your environment variables

Copy the sample env file in `server/`:

```sh
cp server/.env.example server/.env
```

Next open the newly created `server/.env` and set:

- `RECALL_API_URL` to the region your workspace lives in. The sidecar reads this same value. An upload token from one region will not record against another.
- `RECALL_API_KEY` from Developers > API Keys in that region's dashboard.
- `RECALL_WEBHOOK_SECRET`, which depends on when the workspace was created. Both secrets start with `whsec_`.
  - On or after December 15, 2025: the workspace verification secret on the API keys page.
  - Before that date: create the endpoint in the next step, then copy the signing secret shown on that endpoint. Dashboard webhooks on older workspaces are signed with the endpoint secret, not the workspace verification secret.

### 3. Start ngrok

From the terminal, run:

```sh
ngrok http 3000
```

ngrok should now display a forwarding address. In the Recall dashboard for the same region as `RECALL_API_URL`, add a webhook endpoint:

```
https://<ngrok-host>/webhook
```

Dashboards:

- Pay-as-you-go, `us-west-2`: https://us-west-2.recall.ai/dashboard/webhooks
- Monthly, `us-east-1`: https://us-east-1.recall.ai/dashboard/webhooks
- EU: https://eu-central-1.recall.ai/dashboard/webhooks
- Japan: https://ap-northeast-1.recall.ai/dashboard/webhooks

Subscribe to these events:

- `sdk_upload.complete`
- `sdk_upload.failed`
- `sdk_upload.recording_started`
- `sdk_upload.recording_ended`

`sdk_upload.complete` is the event that makes the file available. There is no single "`sdk_upload` events" subscription. If the secret does not match the signature, the server logs `rejected webhook` and the window shows that error instead of staying on Uploading.

Keep this terminal window and ngrok running. 

### 4. Start the server

From a new terminal window, run:

```sh
npm start --prefix server
```

### 5. Running the app

Finally, to run the Tauri desktop applications:

```sh
cd desktop
npm run tauri dev
```

Note that on first launch, you will likely have to give the application permission to access your screen and microphone. This may require a relaunch.

When joining a Google Meet call, the application should detect the call, and allow you to start a recording. 

## What is running

Three processes:

1. **Upload server** (`server/`) - Holds the Recall API key, creates an upload token, and receives webhooks and stores the download URL.
2. **Node sidecar** (`sidecar/`) - Loads `@recallai/desktop-sdk`, asks for macOS permissions, and starts or stops the recording. Stdout is reserved for JSON events. The SDK's own logs are sent to stderr.
3. **Tauri window** (`desktop/`) - Start, Stop, and the link to the finished recording. Spawns the sidecar and keeps the process until the upload has finished or the shutdown wait runs out.
