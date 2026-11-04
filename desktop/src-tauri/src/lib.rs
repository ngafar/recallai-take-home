use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

struct Sidecar {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
}

struct SdkEvents(Arc<Mutex<Vec<Value>>>);

#[tauri::command]
fn start_recording(sidecar: State<Sidecar>) -> Result<(), String> {
    send_command(&sidecar, "start")
}

#[tauri::command]
fn stop_recording(sidecar: State<Sidecar>) -> Result<(), String> {
    send_command(&sidecar, "stop")
}

#[tauri::command]
fn sdk_events(events: State<SdkEvents>) -> Result<Vec<Value>, String> {
    let log = events.0.lock().map_err(|err| err.to_string())?;
    Ok(log.clone())
}

fn send_command(sidecar: &Sidecar, command: &str) -> Result<(), String> {
    let line = format!("{}\n", json!({ "command": command }));
    let mut stdin = sidecar.stdin.lock().map_err(|err| err.to_string())?;
    stdin
        .write_all(line.as_bytes())
        .map_err(|err| err.to_string())?;
    stdin.flush().map_err(|err| err.to_string())?;
    Ok(())
}

fn spawn_sidecar(app: AppHandle, events: Arc<Mutex<Vec<Value>>>) -> Result<Sidecar, String> {
    let sidecar_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../sidecar");
    if !sidecar_dir.join("index.js").is_file() {
        return Err(format!(
            "Could not find the sidecar at {}",
            sidecar_dir.display()
        ));
    }

    // Dev mode runs the system Node. Packaging would ship a Node binary instead.
    let mut child = Command::new("node")
        .arg("index.js")
        .current_dir(&sidecar_dir)
        .env("SDK_IPC", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|err| format!("Could not start the Node sidecar: {err}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("Sidecar stdout was not piped")?;
    let stdin = child.stdin.take().ok_or("Sidecar stdin was not piped")?;

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut seq = 0_u64;
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            let Ok(payload) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            seq += 1;
            let event = json!({ "seq": seq, "payload": payload });
            if let Ok(mut log) = events.lock() {
                log.push(event.clone());
            }
            let _ = app.emit("sdk", event);
        }
    });

    Ok(Sidecar {
        stdin: Mutex::new(stdin),
        child: Mutex::new(child),
    })
}

fn stop_sidecar(sidecar: &Sidecar) {
    if send_command(sidecar, "shutdown").is_err() {
        // The process may already be gone.
    }

    let Ok(mut child) = sidecar.child.lock() else {
        return;
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let events = Arc::new(Mutex::new(Vec::new()));
            let sidecar = spawn_sidecar(app.handle().clone(), events.clone())
                .map_err(std::io::Error::other)?;
            app.manage(sidecar);
            app.manage(SdkEvents(events));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            sdk_events
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(sidecar) = app.try_state::<Sidecar>() {
                    stop_sidecar(sidecar.inner());
                }
            }
        });
}
