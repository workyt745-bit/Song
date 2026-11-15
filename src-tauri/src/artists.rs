//! Artist photos and biography, fetched once per artist and kept on disk.
//!
//! Sources: TheAudioDB (biography + a few photos), Deezer (one photo), Wikipedia
//! (biography + one photo) and Wikimedia Commons (many free photos). All are asked
//! at the same time and the photos are downloaded in parallel. Nothing is fetched again once an
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

const MAX_IMAGES: usize = 12;
/// Bump this to make older cached artists look for photos again.
const CACHE_VER: u32 = 2;
/// Photos downloaded at the same time.
const PARALLEL: usize = 6;
/// One photo bigger than this is skipped (keeps data use low).
const MAX_IMAGE_BYTES: u64 = 4 * 1024 * 1024;
/// Stop downloading more photos for one artist after this much.
const MAX_TOTAL_BYTES: u64 = 16 * 1024 * 1024;
/// Saved photos are at most this many pixels on the long side.
const MAX_SIDE: u32 = 1400;
const MIN_SIDE: u32 = 300;
/// When nothing was found, wait this long before asking again.
const RETRY_AFTER_SECS: u64 = 14 * 24 * 3600;

pub struct Endpoints {
    pub audiodb: String,
    pub deezer: String,
    pub wiki: String,
    pub commons: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            audiodb: "https://www.theaudiodb.com/api/v1/json/2".into(),
            deezer: "https://api.deezer.com".into(),
            wiki: "https://en.wikipedia.org/api/rest_v1".into(),
            commons: "https://commons.wikimedia.org/w/api.php".into(),
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
    #[serde(default)]
    pub ver: u32,
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

type Urls = Vec<(String, &'static str)>;

fn from_audiodb(a: &ureq::Agent, name: &str, ep: &Endpoints) -> Result<(String, Urls), String> {
    let (mut bio, mut urls) = (String::new(), vec![]);
    if let Some(v) = get_json(a, &format!("{}/search.php", ep.audiodb), &[("s", name)])? {
        if let Some(art) = v["artists"].as_array().and_then(|x| x.first()) {
            if norm(str_of(art, "strArtist")) == norm(name) {
                bio = tidy_bio(str_of(art, "strBiographyEN"));
                for key in ["strArtistFanart", "strArtistFanart2", "strArtistFanart3", "strArtistFanart4", "strArtistWideThumb", "strArtistThumb"] {
                    let u = str_of(art, key);
                    if u.starts_with("http") {
                        urls.push((u.to_string(), "TheAudioDB"));
                    }
                }
            }
        }
    }
    Ok((bio, urls))
}

fn from_deezer(a: &ureq::Agent, name: &str, ep: &Endpoints) -> Result<Urls, String> {
    let mut urls = vec![];
    if let Some(v) = get_json(a, &format!("{}/search/artist", ep.deezer), &[("q", name), ("limit", "1")])? {
        if let Some(d) = v["data"].as_array().and_then(|x| x.first()) {
            if norm(str_of(d, "name")) == norm(name) {
                for key in ["picture_xl", "picture_big"] {
                    let u = str_of(d, key);
                    if u.starts_with("http") {
                        urls.push((u.to_string(), "Deezer"));
                        break;
                    }
                }
            }
        }
    }
    Ok(urls)
}

fn from_wikipedia(a: &ureq::Agent, name: &str, ep: &Endpoints) -> Result<(String, Urls), String> {
    let (mut bio, mut urls) = (String::new(), vec![]);
    let title = pct(&name.trim().replace(' ', "_"));
    if let Some(v) = get_json(a, &format!("{}/page/summary/{}", ep.wiki, title), &[])? {
        let desc = str_of(&v, "description").to_lowercase();
        let music = ["singer", "songwriter", "musician", "band", "rapper", "composer", "producer", "duo", "group", "dj", "vocalist", "guitarist", "pianist", "artist"];
        if v["type"].as_str() != Some("disambiguation") && music.iter().any(|w| desc.contains(w)) {
            bio = tidy_bio(str_of(&v, "extract"));
            for path in ["originalimage", "thumbnail"] {
                let u = v[path]["source"].as_str().unwrap_or("");
                if u.starts_with("http") {
                    urls.push((u.to_string(), "Wikipedia"));
                }
            }
        }
    }
    Ok((bio, urls))
}

/// Wikimedia Commons: lots of free photos (concerts, portraits). Only files with the artist's name in
/// the title are kept, and covers, logos, maps and the like are skipped.
fn from_commons(a: &ureq::Agent, name: &str, ep: &Endpoints) -> Result<Urls, String> {
    let q = format!("\"{name}\" filetype:bitmap");
    let Some(v) = get_json(
        a,
        &ep.commons,
        &[
            ("action", "query"), ("format", "json"), ("generator", "search"), ("gsrsearch", &q), ("gsrnamespace", "6"),
            ("gsrlimit", "50"), ("prop", "imageinfo"), ("iiprop", "url|size|mime"), ("iiurlwidth", "1400"),
        ],
    )? else { return Ok(vec![]) };
    let Some(pages) = v["query"]["pages"].as_object() else { return Ok(vec![]) };
    let wanted = norm(name);
    let bad = ["album", "cover", "logo", "signature", "autograph", "discography", "poster", "map", "chart", "stamp", "wax", "statue", "ticket", "tour dates", "billboard", "single"];
    let mut found: Vec<(i64, bool, String)> = vec![];
    for pg in pages.values() {
        let title = str_of(pg, "title");
        let low = title.to_lowercase();
        if !norm(title).contains(&wanted) || bad.iter().any(|w| low.contains(w)) {
            continue;
        }
        let Some(info) = pg["imageinfo"].as_array().and_then(|x| x.first()) else { continue };
        let mime = str_of(info, "mime");
        let (w, h) = (info["width"].as_u64().unwrap_or(0), info["height"].as_u64().unwrap_or(0));
        if !(mime == "image/jpeg" || mime == "image/png") || w < 900 || h < 600 {
            continue;
        }
        let u = match str_of(info, "thumburl") {
            "" => str_of(info, "url"),
            t => t,
        };
        if u.starts_with("http") {
            found.push((pg["index"].as_i64().unwrap_or(999), w as f64 >= h as f64 * 1.15, u.to_string()));
        }
    }
    // Wide photos first (they fill the screen best), each group in search order.
    found.sort_by_key(|(i, wide, _)| (!*wide, *i));
    Ok(found.into_iter().map(|(_, _, u)| (u, "Wikimedia Commons")).collect())
}

fn find_online(a: &ureq::Agent, name: &str, ep: &Endpoints) -> Result<Found, String> {
    // All four sources are asked at the same time.
    let (adb, dz, wiki, com) = std::thread::scope(|sc| {
        let h1 = sc.spawn(|| from_audiodb(a, name, ep));
        let h2 = sc.spawn(|| from_deezer(a, name, ep));
        let h3 = sc.spawn(|| from_wikipedia(a, name, ep));
        let h4 = sc.spawn(|| from_commons(a, name, ep));
        let bad = || Err("offline: worker stopped".to_string());
        (h1.join().unwrap_or_else(|_| bad()), h2.join().unwrap_or_else(|_| Err("x".into())), h3.join().unwrap_or_else(|_| Err("x".into())), h4.join().unwrap_or_else(|_| Err("x".into())))
    });
    // Offline only when every source was unreachable.
    if let (Err(e), Err(_), Err(_), Err(_)) = (&adb, &dz, &wiki, &com) {
        return Err(e.clone());
    }
    let mut f = Found { bio: String::new(), urls: vec![] };
    if let Ok((bio, urls)) = adb {
        f.bio = bio;
        f.urls.extend(urls);
    }
    if let Ok(urls) = dz {
        f.urls.extend(urls);
    }
    if let Ok((bio, urls)) = wiki {
        if f.bio.is_empty() {
            f.bio = bio;
        }
        f.urls.extend(urls);
    }
    if let Ok(urls) = com {
        f.urls.extend(urls);
    }
    let mut seen = HashSet::new();
    f.urls.retain(|(u, _)| seen.insert(u.clone()));
    f.urls.truncate(MAX_IMAGES * 2);
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

    let old = cached(&dir);
    if let Some(c) = &old {
        let files_ok = !c.images.is_empty() && c.images.iter().all(|f| dir.join(f).exists());
        let nothing_recently = c.images.is_empty() && now().saturating_sub(c.fetched) < RETRY_AFTER_SECS;
        if (files_ok || nothing_recently) && c.ver >= CACHE_VER {
            return Ok(c.clone());
        }
    }

    let a = agent();
    let found = match find_online(&a, name, ep) {
        Ok(f) => f,
        // Offline while refreshing an older save: keep showing what we have.
        Err(e) => match old {
            Some(c) if !c.images.is_empty() && c.images.iter().all(|f| dir.join(f).exists()) => return Ok(c),
            _ => return Err(e),
        },
    };

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
    // Download in parallel, a few at a time, and keep the order the sources gave.
    'outer: for chunk in found.urls.chunks(PARALLEL) {
        let got: Vec<Option<(u64, Vec<u8>, usize)>> = std::thread::scope(|sc| {
            let hs: Vec<_> = chunk
                .iter()
                .map(|(url, _)| {
                    let a = &a;
                    sc.spawn(move || {
                        let bytes = get_bytes(a, url, MAX_IMAGE_BYTES)?;
                        let hash = fnv1a(&bytes);
                        let n = bytes.len();
                        Some((hash, shrink(&bytes)?, n))
                    })
                })
                .collect();
            hs.into_iter().map(|h| h.join().ok().flatten()).collect()
        });
        for ((_, source), item) in chunk.iter().zip(got) {
            let Some((hash, jpg, n)) = item else { continue };
            total += n as u64;
            if !seen.insert(hash) {
                continue;
            }
            let file = format!("{}.jpg", saved.len() + 1);
            if write_atomic(&dir.join(&file), &jpg).is_ok() {
                saved.push(file);
                if !credits.contains(source) {
                    credits.push(source);
                }
            }
            if saved.len() >= MAX_IMAGES || total > MAX_TOTAL_BYTES {
                break 'outer;
            }
        }
    }

    let info = ArtistInfo {
        name: name.to_string(),
        bio: found.bio,
        credit: credits.join(" · "),
        images: saved,
        fetched: now(),
        ver: CACHE_VER,
    };
    let json = serde_json::to_vec(&info).map_err(|e| e.to_string())?;
    write_atomic(&dir.join("info.json"), &json).map_err(|e| e.to_string())?;
    Ok(info)
}
