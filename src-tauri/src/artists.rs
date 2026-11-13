//! Artist photos and biography, fetched once per artist and kept on disk.
//!
//! Sources, in order: TheAudioDB (several photos + biography), Deezer (one
//! photo), Wikipedia (biography + one photo). Nothing is fetched again once an
//! artist is cached, so after the first time Pulse uses no internet for them.
//! Every download has a size limit, and photos are shrunk before saving.

use crate::library::{fnv1a, write_atomic};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_IMAGES: usize = 5;
/// One photo bigger than this is skipped (keeps data use low).
const MAX_IMAGE_BYTES: u64 = 4 * 1024 * 1024;
/// Stop downloading more photos for one artist after this much.
const MAX_TOTAL_BYTES: u64 = 9 * 1024 * 1024;
/// Saved photos are at most this many pixels on the long side.
const MAX_SIDE: u32 = 1400;
const MIN_SIDE: u32 = 300;
/// When nothing was found, wait this long before asking again.
const RETRY_AFTER_SECS: u64 = 14 * 24 * 3600;

pub struct Endpoints {
    pub audiodb: String,
    pub deezer: String,
    pub wiki: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            audiodb: "https://www.theaudiodb.com/api/v1/json/2".into(),
            deezer: "https://api.deezer.com".into(),
            wiki: "https://en.wikipedia.org/api/rest_v1".into(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ArtistInfo {
    pub name: String,
    pub bio: String,
    pub credit: String,
    /// File names inside the artist's cache folder.
    pub images: Vec<String>,
    pub fetched: u64,
}

pub(crate) fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Lower-case letters and digits only, so "AC/DC" and "ac dc" match.
pub(crate) fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(|c| c.to_lowercase()).collect()
}

pub fn dir_for(root: &Path, name: &str) -> PathBuf {
    root.join(format!("{:016x}", fnv1a(norm(name).as_bytes())))
}

pub fn cached(dir: &Path) -> Option<ArtistInfo> {
    serde_json::from_slice(&fs::read(dir.join("info.json")).ok()?).ok()
}

pub(crate) fn pct(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => o.push(b as char),
            _ => o.push_str(&format!("%{:02X}", b)),
        }
    }
    o
}

pub(crate) fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(6))
        .timeout(Duration::from_secs(20))
        .user_agent("Pulse/0.1 (personal music player)")
        .build()
}

/// Ok(None) = the site answered but had nothing. Err = could not reach the internet.
pub(crate) fn get_json(a: &ureq::Agent, url: &str, query: &[(&str, &str)]) -> Result<Option<Value>, String> {
    let mut req = a.get(url);
    for (k, v) in query {
        req = req.query(k, v);
    }
    match req.call() {
        Ok(resp) => Ok(resp.into_string().ok().and_then(|t| serde_json::from_str::<Value>(&t).ok())),
        Err(ureq::Error::Status(_, _)) => Ok(None),
        Err(ureq::Error::Transport(t)) => Err(format!("offline: {t}")),
    }
}

fn get_bytes(a: &ureq::Agent, url: &str, limit: u64) -> Option<Vec<u8>> {
    let resp = a.get(url).call().ok()?;
    if let Some(len) = resp.header("content-length").and_then(|v| v.parse::<u64>().ok()) {
        if len > limit {
            return None;
        }
    }
    let mut buf = Vec::new();
    resp.into_reader().take(limit + 1).read_to_end(&mut buf).ok()?;
    if buf.len() as u64 > limit {
        return None;
    }
    Some(buf)
}

/// Keeps the biography readable: trims it and ends it on a full sentence.
fn tidy_bio(s: &str) -> String {
    let t = s.replace("\r\n", "\n").trim().to_string();
    let limit = 1800;
    if t.chars().count() <= limit {
        return t;
    }
    let cut: String = t.chars().take(limit).collect();
    match cut.rfind(". ") {
        Some(i) if i > limit / 2 => cut[..=i].to_string(),
        _ => format!("{}…", cut.trim_end()),
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("").trim()
}

struct Found {
    bio: String,
    urls: Vec<(String, &'static str)>,
}

fn find_online(a: &ureq::Agent, name: &str, ep: &Endpoints) -> Result<Found, String> {
    let mut f = Found { bio: String::new(), urls: vec![] };

    // 1. TheAudioDB: biography and several photos. This is also the connection check.
    if let Some(v) = get_json(a, &format!("{}/search.php", ep.audiodb), &[("s", name)])? {
        if let Some(art) = v["artists"].as_array().and_then(|x| x.first()) {
            if norm(str_of(art, "strArtist")) == norm(name) {
                f.bio = tidy_bio(str_of(art, "strBiographyEN"));
                for key in [
                    "strArtistFanart",
                    "strArtistFanart2",
                    "strArtistFanart3",
                    "strArtistFanart4",
                    "strArtistWideThumb",
                    "strArtistThumb",
                ] {
                    let u = str_of(art, key);
                    if u.starts_with("http") {
                        f.urls.push((u.to_string(), "TheAudioDB"));
                    }
                }
            }
        }
    }

    // 2. Deezer: one good photo when the first source had fewer than two.
    if f.urls.len() < 2 {
        if let Ok(Some(v)) = get_json(a, &format!("{}/search/artist", ep.deezer), &[("q", name), ("limit", "1")]) {
            if let Some(d) = v["data"].as_array().and_then(|x| x.first()) {
                if norm(str_of(d, "name")) == norm(name) {
                    for key in ["picture_xl", "picture_big"] {
                        let u = str_of(d, key);
                        if u.starts_with("http") {
                            f.urls.push((u.to_string(), "Deezer"));
                            break;
                        }
                    }
                }
            }
        }
    }

    // 3. Wikipedia: biography and a photo when we still have nothing.
    if f.bio.is_empty() || f.urls.is_empty() {
        let title = pct(&name.trim().replace(' ', "_"));
        if let Ok(Some(v)) = get_json(a, &format!("{}/page/summary/{}", ep.wiki, title), &[]) {
            let desc = str_of(&v, "description").to_lowercase();
            let music = ["singer", "songwriter", "musician", "band", "rapper", "composer", "producer", "duo", "group", "dj", "vocalist", "guitarist", "pianist", "artist"];
            if v["type"].as_str() != Some("disambiguation") && music.iter().any(|w| desc.contains(w)) {
                if f.bio.is_empty() {
                    f.bio = tidy_bio(str_of(&v, "extract"));
                }
                for path in ["originalimage", "thumbnail"] {
                    let u = v[path]["source"].as_str().unwrap_or("");
                    if u.starts_with("http") {
                        f.urls.push((u.to_string(), "Wikipedia"));
                    }
                }
            }
        }
    }
    Ok(f)
}

fn shrink(bytes: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    if img.width() < MIN_SIDE && img.height() < MIN_SIDE {
        return None;
    }
    let img = if img.width() > MAX_SIDE || img.height() > MAX_SIDE {
        img.resize(MAX_SIDE, MAX_SIDE, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let mut out = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 78);
    img.to_rgb8().write_with_encoder(enc).ok()?;
    Some(out)
}

/// Returns what we know about the artist, from disk when possible.
/// `Err` only means "no internet right now": nothing is saved, so we try again later.
pub fn get_info(root: &Path, name: &str, ep: &Endpoints) -> Result<ArtistInfo, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("no artist name".into());
    }
    let dir = dir_for(root, name);

    if let Some(c) = cached(&dir) {
        let files_ok = !c.images.is_empty() && c.images.iter().all(|f| dir.join(f).exists());
        let nothing_recently = c.images.is_empty() && now().saturating_sub(c.fetched) < RETRY_AFTER_SECS;
        if files_ok || nothing_recently {
            return Ok(c);
        }
    }

    let a = agent();
    let found = find_online(&a, name, ep)?;

    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            if e.path().extension().map(|x| x == "jpg").unwrap_or(false) {
                let _ = fs::remove_file(e.path());
            }
        }
    }

    let mut saved: Vec<String> = Vec::new();
    let mut seen: HashSet<u64> = HashSet::new();
    let mut total = 0u64;
    let mut credits: Vec<&str> = Vec::new();
    if !found.bio.is_empty() {
        credits.push(if found.urls.iter().any(|(_, s)| *s == "TheAudioDB") { "TheAudioDB" } else { "Wikipedia" });
    }
    for (url, source) in &found.urls {
        if saved.len() >= MAX_IMAGES || total > MAX_TOTAL_BYTES {
            break;
        }
        let Some(bytes) = get_bytes(&a, url, MAX_IMAGE_BYTES) else { continue };
        total += bytes.len() as u64;
        if !seen.insert(fnv1a(&bytes)) {
            continue;
        }
        let Some(jpg) = shrink(&bytes) else { continue };
        let file = format!("{}.jpg", saved.len() + 1);
        if write_atomic(&dir.join(&file), &jpg).is_ok() {
            saved.push(file);
            if !credits.contains(source) {
                credits.push(source);
            }
        }
    }

    let info = ArtistInfo {
        name: name.to_string(),
        bio: found.bio,
        credit: credits.join(" · "),
        images: saved,
        fetched: now(),
    };
    let json = serde_json::to_vec(&info).map_err(|e| e.to_string())?;
    write_atomic(&dir.join("info.json"), &json).map_err(|e| e.to_string())?;
    Ok(info)
}
