//! Library scanning, tag reading and cover-art caching.
//!
//! Deliberately free of any Tauri types so it can be tested on its own.
//! Design goals: low memory (cover art is shrunk to small JPEG thumbnails on
//! disk, never held in RAM), fast re-scans (unchanged files come from a cache).

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::Accessor;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

/// Formats the Windows web view can decode natively.
const AUDIO_EXTS: &[&str] = &["mp3", "m4a", "aac", "flac", "ogg", "opus", "wav"];
const FOLDER_ART: &[&str] = &[
    "cover.jpg",
    "cover.png",
    "folder.jpg",
    "folder.png",
    "front.jpg",
    "front.png",
    "albumart.jpg",
];
const THUMB_SIZE: u32 = 320;
/// Tiny copy used in song lists (40 px slots). Decoding a 96 px picture takes about 10x less memory than a 320 px one.
const SMALL_SIZE: u32 = 96;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Song {
    pub id: String,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub track: u32,
    pub disc: u32,
    pub year: u32,
    /// Duration in seconds.
    pub duration: f32,
    /// Key of the cached thumbnail (`<key>.jpg` in the covers folder).
    pub cover: Option<String>,
    /// Dominant colour of the cover as `#rrggbb` (empty when there is no cover).
    #[serde(default)]
    pub color: String,
    pub mtime: u64,
    pub size: u64,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Library {
    pub folders: Vec<String>,
    /// Songs added one by one (not through a folder).
    #[serde(default)]
    pub files: Vec<String>,
    pub songs: Vec<Song>,
}

/// Small, stable, dependency-free hash (FNV-1a, 64 bit).
pub fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all().ok();
    }
    fs::rename(tmp, path)
}

pub fn load_library(file: &Path) -> Library {
    fs::read(file)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn save_library(file: &Path, lib: &Library) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(lib).map_err(std::io::Error::other)?;
    write_atomic(file, &bytes)
}

/// Picks a vivid representative colour: pixels are weighted by how saturated
/// and bright they are, so a mostly-grey cover with one red logo reads as red.
fn dominant_color(img: &image::DynamicImage) -> String {
    let tiny = img.resize(24, 24, image::imageops::FilterType::Triangle).to_rgb8();
    let (mut r, mut g, mut b, mut wsum) = (0f64, 0f64, 0f64, 0f64);
    let (mut ar, mut ag, mut ab, mut n) = (0f64, 0f64, 0f64, 0f64);
    for px in tiny.pixels() {
        let (pr, pg, pb) = (px[0] as f64, px[1] as f64, px[2] as f64);
        let max = pr.max(pg).max(pb);
        let min = pr.min(pg).min(pb);
        let sat = if max == 0.0 { 0.0 } else { (max - min) / max };
        let val = max / 255.0;
        let w = (sat * sat) * val + 0.0001;
        r += pr * w;
        g += pg * w;
        b += pb * w;
        wsum += w;
        ar += pr;
        ag += pg;
        ab += pb;
        n += 1.0;
    }
    // Nearly grey cover: fall back to the plain average.
    let (fr, fg, fb) = if wsum < 1.0 {
        (ar / n, ag / n, ab / n)
    } else {
        (r / wsum, g / wsum, b / wsum)
    };
    format!("#{:02x}{:02x}{:02x}", fr as u8, fg as u8, fb as u8)
}

/// Shrinks `bytes` to a small JPEG thumbnail; returns its cache key and colour.
fn save_cover(bytes: &[u8], covers_dir: &Path) -> Option<(String, String)> {
    let key = format!("{:016x}", fnv1a(bytes));
    let out = covers_dir.join(format!("{key}.jpg"));
    if out.exists() {
        // Thumbnail is already cached: derive the colour from the small file.
        let small = image::open(&out).ok()?;
        return Some((key, dominant_color(&small)));
    }
    let img = image::load_from_memory(bytes).ok()?;
    let small = img.resize(THUMB_SIZE, THUMB_SIZE, image::imageops::FilterType::Triangle);
    let color = dominant_color(&small);
    let rgb = small.to_rgb8();
    let mut buf = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 82);
    rgb.write_with_encoder(enc).ok()?;
    fs::create_dir_all(covers_dir).ok()?;
    let tmp = covers_dir.join(format!("{key}.{:?}.tmp", std::thread::current().id()));
    fs::write(&tmp, &buf).ok()?;
    fs::rename(&tmp, &out).ok()?;
    write_small(&small, covers_dir, &key);
    Some((key, color))
}

fn write_small(from: &image::DynamicImage, covers_dir: &Path, key: &str) {
    let out = covers_dir.join(format!("{key}_s.jpg"));
    let small = from.resize(SMALL_SIZE, SMALL_SIZE, image::imageops::FilterType::Triangle).to_rgb8();
    let mut buf = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 80);
    if small.write_with_encoder(enc).is_ok() {
        let tmp = covers_dir.join(format!("{key}_s.{:?}.tmp", std::thread::current().id()));
        if fs::write(&tmp, &buf).is_ok() {
            let _ = fs::rename(&tmp, &out);
        }
    }
}

/// Makes the tiny copies for covers saved by older versions. Runs quietly in the background, one picture at a time.
pub fn backfill_small_covers(covers_dir: &Path) {
    let Ok(rd) = fs::read_dir(covers_dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let Some(key) = name.strip_suffix(".jpg") else { continue };
        if key.ends_with("_s") || covers_dir.join(format!("{key}_s.jpg")).exists() {
            continue;
        }
        if let Ok(img) = image::open(&p) {
            write_small(&img, covers_dir, key);
        }
        std::thread::sleep(std::time::Duration::from_millis(4));
    }
}

fn folder_art(dir: &Path) -> Option<Vec<u8>> {
    for name in FOLDER_ART {
        let p = dir.join(name);
        if p.is_file() {
            if let Ok(b) = fs::read(&p) {
                return Some(b);
            }
        }
    }
    None
}

fn read_song(path: &Path, covers_dir: &Path) -> Option<Song> {
    let meta = fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path_str = path.to_string_lossy().to_string();

    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Unknown".into());

    let mut song = Song {
        id: format!("{:016x}", fnv1a(path_str.as_bytes())),
        path: path_str,
        title: stem,
        artist: "Unknown Artist".into(),
        album: "Unknown Album".into(),
        album_artist: String::new(),
        track: 0,
        disc: 0,
        year: 0,
        duration: 0.0,
        cover: None,
        color: String::new(),
        mtime,
        size: meta.len(),
    };

    let mut cover_bytes: Option<Vec<u8>> = None;

    if let Ok(tagged) = lofty::read_from_path(path) {
        song.duration = tagged.properties().duration().as_secs_f32();
        if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
            if let Some(v) = tag.title() {
                if !v.trim().is_empty() {
                    song.title = v.trim().to_string();
                }
            }
            if let Some(v) = tag.artist() {
                if !v.trim().is_empty() {
                    song.artist = v.trim().to_string();
                }
            }
            if let Some(v) = tag.album() {
                if !v.trim().is_empty() {
                    song.album = v.trim().to_string();
                }
            }
            if let Some(v) = tag.get_string(lofty::tag::ItemKey::AlbumArtist) {
                song.album_artist = v.trim().to_string();
            }
            song.track = tag.track().unwrap_or(0);
            song.disc = tag.disk().unwrap_or(0);
            song.year = tag.date().map(|d| d.year as u32).unwrap_or(0);
            cover_bytes = tag.pictures().first().map(|p| p.data().to_vec());
        }
    }

    if cover_bytes.is_none() {
        if let Some(dir) = path.parent() {
            cover_bytes = folder_art(dir);
        }
    }
    if let Some(bytes) = cover_bytes {
        if let Some((key, color)) = save_cover(&bytes, covers_dir) {
            song.cover = Some(key);
            song.color = color;
        }
    }
    Some(song)
}

pub fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Walks `folders`, re-reading only new or changed files.
/// `progress(done, total)` is called now and then while tags are read.
pub fn scan(
    folders: &[String],
    single_files: &[String],
    cached: Vec<Song>,
    covers_dir: &Path,
    progress: &(dyn Fn(usize, usize) + Sync),
) -> Vec<Song> {
    let mut files: Vec<PathBuf> = Vec::new();
    for folder in folders {
        for entry in WalkDir::new(folder)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if entry.file_type().is_file() && is_audio(entry.path()) {
                files.push(entry.into_path());
            }
        }
    }
    for f in single_files {
        let p = PathBuf::from(f);
        if p.is_file() && is_audio(&p) {
            files.push(p);
        }
    }
    files.sort();
    files.dedup();

    let cache: HashMap<String, Song> = cached.into_iter().map(|s| (s.path.clone(), s)).collect();

    // Split into unchanged (reuse) and new/changed (read tags).
    let mut slots: Vec<Option<Song>> = Vec::with_capacity(files.len());
    let mut todo: Vec<usize> = Vec::new();
    for (i, f) in files.iter().enumerate() {
        let key = f.to_string_lossy().to_string();
        let fresh = cache.get(&key).filter(|c| {
            fs::metadata(f)
                .map(|m| {
                    m.len() == c.size
                        && m.modified()
                            .ok()
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|d| d.as_secs())
                            .unwrap_or(0)
                            == c.mtime
                })
                .unwrap_or(false)
                // Re-read if its cover thumbnail has gone missing.
                && c.cover
                    .as_ref()
                    .map(|k| covers_dir.join(format!("{k}.jpg")).exists())
                    .unwrap_or(true)
        });
        match fresh {
            Some(c) => slots.push(Some(c.clone())),
            None => {
                slots.push(None);
                todo.push(i);
            }
        }
    }

    let total = todo.len();
    progress(0, total);
    if total > 0 {
        let results: Mutex<Vec<(usize, Option<Song>)>> = Mutex::new(Vec::with_capacity(total));
        let next = AtomicUsize::new(0);
        let done = AtomicUsize::new(0);
        let workers = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(2)
            .clamp(1, 4);
        std::thread::scope(|s| {
            for _ in 0..workers {
                s.spawn(|| loop {
                    let n = next.fetch_add(1, Ordering::Relaxed);
                    if n >= total {
                        break;
                    }
                    let idx = todo[n];
                    let song = read_song(&files[idx], covers_dir);
                    results.lock().unwrap().push((idx, song));
                    let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                    if d % 20 == 0 || d == total {
                        progress(d, total);
                    }
                });
            }
        });
        for (idx, song) in results.into_inner().unwrap() {
            slots[idx] = song;
        }
    }

    slots.into_iter().flatten().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_stable() {
        assert_eq!(fnv1a(b"abc"), fnv1a(b"abc"));
        assert_ne!(fnv1a(b"abc"), fnv1a(b"abd"));
    }
}
