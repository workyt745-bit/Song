pub mod artists;
pub mod lyrics;
pub mod library;
#[cfg(all(windows, feature = "taskbar"))]
mod thumbbar;

use library::{Library, Song};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

struct Paths {
    covers: PathBuf,
    artists: PathBuf,
    lyrics: PathBuf,
    library: PathBuf,
    store: PathBuf,
}

fn paths(app: &AppHandle) -> Result<Paths, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(Paths {
        covers: dir.join("covers"),
        artists: dir.join("artists"),
        lyrics: dir.join("lyrics"),
        library: dir.join("library.json"),
        store: dir.join("store.json"),
    })
}

/// Lets the web view stream audio files and thumbnails from these folders.
fn allow_sources(app: &AppHandle, folders: &[String], files: &[String]) {
    let scope = app.asset_protocol_scope();
    for f in folders {
        let _ = scope.allow_directory(f, true);
    }
    for f in files {
        let _ = scope.allow_file(f);
    }
}

#[derive(Serialize)]
struct Loaded {
    folders: Vec<String>,
    files: Vec<String>,
    songs: Vec<Song>,
    covers_dir: String,
}

/// Instant start-up: returns whatever was cached by the last scan.
#[tauri::command]
fn load_library(app: AppHandle) -> Result<Loaded, String> {
    let p = paths(&app)?;
    let lib = library::load_library(&p.library);
    let _ = std::fs::create_dir_all(&p.covers);
    allow_sources(&app, &lib.folders, &lib.files);
    let _ = app.asset_protocol_scope().allow_directory(&p.covers, true);
    Ok(Loaded {
        folders: lib.folders,
        files: lib.files,
        songs: lib.songs,
        covers_dir: p.covers.to_string_lossy().to_string(),
    })
}

#[derive(Serialize, Clone)]
struct Progress {
    done: usize,
    total: usize,
}

#[derive(Serialize)]
struct Sorted {
    folders: Vec<String>,
    files: Vec<String>,
}

/// Splits dropped or picked paths into folders and playable song files.
#[tauri::command]
fn classify_paths(paths: Vec<String>) -> Sorted {
    let mut out = Sorted { folders: vec![], files: vec![] };
    for p in paths {
        let path = std::path::Path::new(&p);
        if path.is_dir() {
            out.folders.push(p);
        } else if path.is_file() && library::is_audio(path) {
            out.files.push(p);
        }
    }
    out
}

/// Scans the given folders and single files (only new or changed files are re-read).
#[tauri::command]
async fn scan_library(app: AppHandle, folders: Vec<String>, files: Vec<String>) -> Result<Vec<Song>, String> {
    let p = paths(&app)?;
    allow_sources(&app, &folders, &files);
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cached = library::load_library(&p.library).songs;
        let progress = |done: usize, total: usize| {
            let _ = handle.emit("scan-progress", Progress { done, total });
        };
        let songs = library::scan(&folders, &files, cached, &p.covers, &progress);
        let lib = Library {
            folders,
            files,
            songs: songs.clone(),
        };
        library::save_library(&p.library, &lib).map_err(|e| e.to_string())?;
        Ok(songs)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct ArtistOut {
    name: String,
    bio: String,
    credit: String,
    /// Full paths of the saved photos.
    images: Vec<String>,
}

/// Photos and biography for one artist. Downloaded the first time only, then read from disk.
#[tauri::command]
async fn artist_info(app: AppHandle, name: String) -> Result<ArtistOut, String> {
    let p = paths(&app)?;
    let _ = std::fs::create_dir_all(&p.artists);
    let _ = app.asset_protocol_scope().allow_directory(&p.artists, true);
    tauri::async_runtime::spawn_blocking(move || {
        let info = artists::get_info(&p.artists, &name, &artists::Endpoints::default())?;
        let dir = artists::dir_for(&p.artists, &name);
        Ok(ArtistOut {
            name: info.name,
            bio: info.bio,
            credit: info.credit,
            images: info.images.iter().map(|f| dir.join(f).to_string_lossy().to_string()).collect(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Lyrics for the playing song. Looked up once online, then read from disk.
#[tauri::command]
async fn lyrics_for(app: AppHandle, artist: String, title: String, album: String, duration: f32, path: String, online: bool) -> Result<lyrics::Lyrics, String> {
    let p = paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let q = lyrics::Query { artist: &artist, title: &title, album: &album, duration, path: &path };
        lyrics::get(&p.lyrics, &q, lyrics::DEFAULT_ENDPOINT, online)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Tells the Windows taskbar buttons whether music is playing (so the middle one shows Pause or Play).
#[tauri::command]
fn set_thumb_playing(app: AppHandle, playing: bool) {
    #[cfg(all(windows, feature = "taskbar"))]
    {
        let _ = app.run_on_main_thread(move || thumbbar::set_playing(playing));
    }
    #[cfg(not(all(windows, feature = "taskbar")))]
    {
        let _ = (app, playing);
    }
}

/// Wipes everything Pulse saved about itself (song list, playlists, likes, caches).
/// It only touches Pulse's own data folder. Your music files are never touched.
#[tauri::command]
fn reset_app(app: AppHandle) -> Result<(), String> {
    let p = paths(&app)?;
    for f in [&p.library, &p.store] {
        let _ = std::fs::remove_file(f);
    }
    for d in [&p.covers, &p.artists, &p.lyrics] {
        let _ = std::fs::remove_dir_all(d);
    }
    Ok(())
}

/// Playlists, likes, settings, last-played: the UI owns this JSON blob.
#[tauri::command]
fn load_store(app: AppHandle) -> Result<String, String> {
    let p = paths(&app)?;
    Ok(std::fs::read_to_string(p.store).unwrap_or_default())
}

#[tauri::command]
fn save_store(app: AppHandle, json: String) -> Result<(), String> {
    let p = paths(&app)?;
    library::write_atomic(&p.store, json.as_bytes()).map_err(|e| e.to_string())
}

/// When on, closing the window hides Pulse in the tray and the music keeps playing.
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

#[tauri::command]
fn set_close_to_tray(on: bool) {
    CLOSE_TO_TRAY.store(on, Ordering::Relaxed);
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// The small always-on-top player. The big window hides while it is open.
// async on purpose: making a window inside a normal (sync) command freezes the whole app on Windows.
#[tauri::command]
async fn open_mini(app: AppHandle) -> Result<(), String> {
    if let Some(m) = app.get_webview_window("mini") {
        let _ = m.show();
        let _ = m.set_focus();
    } else {
        tauri::WebviewWindowBuilder::new(&app, "mini", tauri::WebviewUrl::App("mini.html".into()))
            .title("Pulse")
            .inner_size(390.0, 96.0)
            .resizable(false)
            .maximizable(false)
            .decorations(false)
            .always_on_top(true)
            .shadow(true)
            .background_color(tauri::window::Color(14, 14, 20, 255))
            .build()
            .map_err(|e| e.to_string())?;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    Ok(())
}

#[tauri::command]
async fn close_mini(app: AppHandle) {
    show_main(&app);
    if let Some(m) = app.get_webview_window("mini") {
        let _ = m.destroy();
    }
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle();
    let menu = Menu::with_items(
        handle,
        &[
            &MenuItem::with_id(handle, "show", "Open Pulse", true, None::<&str>)?,
            &MenuItem::with_id(handle, "mini", "Mini player", true, None::<&str>)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "toggle", "Play / Pause", true, None::<&str>)?,
            &MenuItem::with_id(handle, "next", "Next", true, None::<&str>)?,
            &MenuItem::with_id(handle, "prev", "Previous", true, None::<&str>)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "quit", "Quit Pulse", true, None::<&str>)?,
        ],
    )?;
    let mut b = TrayIconBuilder::with_id("pulse")
        .tooltip("Pulse")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "show" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { close_mini(app).await });
            }
            "mini" => {
                // Never build a window directly inside a menu callback (it would freeze); hand it to another thread.
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = open_mini(app).await;
                });
            }
            "quit" => app.exit(0),
            a @ ("toggle" | "next" | "prev") => {
                let _ = app.emit("thumb-action", a);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                let app = tray.app_handle().clone();
                tauri::async_runtime::spawn(async move { close_mini(app).await });
            }
        });
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.build(handle)?;
    Ok(())
}

/// Keys that work even while another app is in front.
fn setup_shortcuts(app: &tauri::App) {
    let m = Modifiers::CONTROL | Modifiers::ALT;
    let keys = [(Code::ArrowRight, "next"), (Code::ArrowLeft, "prev"), (Code::Space, "toggle")];
    for (code, _) in keys {
        // If another program already owns a combination, skip it quietly.
        let _ = app.global_shortcut().register(Shortcut::new(Some(m), code));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let a = if shortcut.key == Code::ArrowRight {
                        "next"
                    } else if shortcut.key == Code::ArrowLeft {
                        "prev"
                    } else {
                        "toggle"
                    };
                    let _ = app.emit("thumb-action", a);
                })
                .build(),
        )
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    "main" if CLOSE_TO_TRAY.load(Ordering::Relaxed) => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    "mini" => show_main(window.app_handle()),
                    _ => {}
                }
            }
        })
        .setup(|app| {
            let _ = setup_tray(app);
            setup_shortcuts(app);
            #[cfg(all(windows, feature = "taskbar"))]
            if let Some(w) = app.get_webview_window("main") {
                if let Ok(h) = w.hwnd() {
                    thumbbar::install(app.handle(), h.0 as isize);
                }
            }
            #[cfg(not(all(windows, feature = "taskbar")))]
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_library,
            scan_library,
            classify_paths,
            artist_info,
            lyrics_for,
            set_thumb_playing,
            set_close_to_tray,
            reset_app,
            open_mini,
            close_mini,
            load_store,
            save_store
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pulse");
}
