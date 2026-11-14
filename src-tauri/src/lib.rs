pub mod artists;
pub mod lyrics;
pub mod library;
#[cfg(all(windows, feature = "taskbar"))]
mod thumbbar;

use library::{Library, Song};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
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
            load_store,
            save_store
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pulse");
}
