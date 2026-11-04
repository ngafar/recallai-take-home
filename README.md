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

Next open the newly created `server/.env` and add your `RECALL_API_KEY` and `RECALL_WEBHOOK_SECRET`. Both of these can be found in the Recall.ai dashboard, under Developers > API Keys.  

### 3. Start ngrok

From the terminal, run:

```sh
ngrok http 3000
```

ngrok should now display a forwarding address. In the Recall.ai dashboard, add a new webhook endpoint:

```
https://<ngrok-host>/webhook
```

Before saving, subscribe to the `sdk_upload` events. 

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
