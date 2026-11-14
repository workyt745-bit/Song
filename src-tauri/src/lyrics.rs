//! Lyrics for the song that is playing, from LRCLIB (a free lyrics database with timings).
//! Looked up once per song, then kept on disk, so a song costs a few KB of internet one time.

use crate::artists::{agent, get_json, norm, now, pct};
use crate::library::{fnv1a, write_atomic};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const RETRY_AFTER_SECS: u64 = 7 * 24 * 3600;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Line {
    pub t: f32,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Lyrics {
    /// Timed lines (empty when the song only has plain text).
    pub synced: Vec<Line>,
    pub plain: String,
    pub instrumental: bool,
    pub source: String,
    pub fetched: u64,
}

impl Lyrics {
    pub fn is_empty(&self) -> bool {
        self.synced.is_empty() && self.plain.trim().is_empty() && !self.instrumental
    }
}

pub struct Query<'a> {
    pub artist: &'a str,
    pub title: &'a str,
    pub album: &'a str,
    pub duration: f32,
    /// Path of the song file, used to look for a `.lrc` file next to it.
    pub path: &'a str,
}

pub const DEFAULT_ENDPOINT: &str = "https://lrclib.net/api";

fn file_for(root: &Path, q: &Query) -> PathBuf {
    root.join(format!("{:016x}.json", fnv1a(format!("{}|{}", norm(q.artist), norm(q.title)).as_bytes())))
}

/// "[01:23.45]text" -> (83.45, "text"). A line may carry several stamps.
pub fn parse_lrc(src: &str) -> Vec<Line> {
    let mut out = Vec::new();
    for raw in src.lines() {
        let mut rest = raw.trim();
        let mut stamps = Vec::new();
        while rest.starts_with('[') {
            let Some(end) = rest.find(']') else { break };
            let tag = &rest[1..end];
            let ts = (|| {
                let (m, s) = tag.split_once(':')?;
                Some(m.trim().parse::<f32>().ok()? * 60.0 + s.trim().parse::<f32>().ok()?)
            })();
            match ts {
                Some(t) => stamps.push(t),
                None => break, // [ar:..] and friends
            }
            rest = rest[end + 1..].trim_start();
        }
        for t in stamps {
            out.push(Line { t, text: rest.trim().to_string() });
        }
    }
    out.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    out
}

fn strip_timing(lrc: &str) -> String {
    parse_lrc(lrc).into_iter().map(|l| l.text).collect::<Vec<_>>().join("\n")
}

/// "Song (feat. X) - Remastered 2011" -> "Song"
pub fn clean_title(t: &str) -> String {
    let mut s = t.to_string();
    for sep in [" - ", " – "] {
        if let Some(i) = s.find(sep) {
            s.truncate(i);
        }
    }
    loop {
        let (Some(a), Some(b)) = (s.rfind('('), s.rfind(')')) else { break };
        if a < b && s[a..].to_lowercase().contains(|c: char| c.is_alphabetic()) && b == s.trim_end().len() - 1 {
            s.truncate(a);
        } else {
            break;
        }
    }
    s.trim().to_string()
}

fn from_item(v: &Value, source: &str) -> Lyrics {
    let synced = v["syncedLyrics"].as_str().map(parse_lrc).unwrap_or_default();
    let plain = match v["plainLyrics"].as_str() {
        Some(p) if !p.trim().is_empty() => p.trim().to_string(),
        _ => v["syncedLyrics"].as_str().map(strip_timing).unwrap_or_default(),
    };
    Lyrics { synced, plain, instrumental: v["instrumental"].as_bool().unwrap_or(false), source: source.into(), fetched: now() }
}

fn has_text(v: &Value) -> bool {
    v["syncedLyrics"].as_str().map_or(false, |s| !s.trim().is_empty())
        || v["plainLyrics"].as_str().map_or(false, |s| !s.trim().is_empty())
        || v["instrumental"].as_bool() == Some(true)
}

fn lookup(base: &str, q: &Query) -> Result<Option<Lyrics>, String> {
    let a = agent();
    let dur = format!("{}", q.duration.round() as i64);
    let title = clean_title(q.title);
    // 1. exact match by artist, title, album and length
    let mut query: Vec<(&str, &str)> = vec![("artist_name", q.artist), ("track_name", q.title)];
    if !q.album.is_empty() && q.album != "Unknown Album" {
        query.push(("album_name", q.album));
    }
    if q.duration > 0.0 {
        query.push(("duration", &dur));
    }
    if let Some(v) = get_json(&a, &format!("{base}/get"), &query)? {
        if has_text(&v) {
            return Ok(Some(from_item(&v, "LRCLIB")));
        }
    }
    // 2. search, with the title cleaned of "(feat. …)" and "- Remastered"
    let url = format!("{base}/search?artist_name={}&track_name={}", pct(q.artist), pct(&title));
    let Some(Value::Array(items)) = get_json(&a, &url, &[])? else { return Ok(None) };
    let items: Vec<&Value> = items.iter().filter(|v| has_text(v)).collect();
    let near = |v: &&Value| q.duration <= 0.0 || (v["duration"].as_f64().unwrap_or(0.0) - q.duration as f64).abs() <= 4.0;
    let pick = items
        .iter()
        .find(|v| near(v) && v["syncedLyrics"].as_str().map_or(false, |s| !s.is_empty()))
        .or_else(|| items.iter().find(|v| near(v)))
        .or_else(|| items.iter().find(|v| v["syncedLyrics"].as_str().map_or(false, |s| !s.is_empty())));
    // Only accept an artist that actually matches, so a wrong song never shows up.
    let wanted = norm(q.artist);
    let ok = |v: &&&Value| {
        let got = norm(v["artistName"].as_str().unwrap_or(""));
        !wanted.is_empty() && (got.contains(&wanted) || wanted.contains(&got))
    };
    Ok(pick.filter(ok).map(|v| from_item(v, "LRCLIB")))
}

fn sidecar(path: &str) -> Option<Lyrics> {
    let p = Path::new(path).with_extension("lrc");
    let text = fs::read_to_string(p).ok()?;
    let synced = parse_lrc(&text);
    let (plain, synced) = if synced.iter().any(|l| !l.text.is_empty()) { (strip_timing(&text), synced) } else { (text.trim().to_string(), vec![]) };
    let l = Lyrics { synced, plain, instrumental: false, source: "a .lrc file next to the song".into(), fetched: now() };
    (!l.is_empty()).then_some(l)
}

/// Lyrics for one song. `Err` (contains "offline") only when the internet could not be reached;
/// in that case nothing is saved so the next try starts fresh.
pub fn get(root: &Path, q: &Query, base: &str, allow_online: bool) -> Result<Lyrics, String> {
    if let Some(l) = sidecar(q.path) {
        return Ok(l);
    }
    let file = file_for(root, q);
    let cached: Option<Lyrics> = fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok());
    if let Some(c) = &cached {
        if !c.is_empty() || now().saturating_sub(c.fetched) < RETRY_AFTER_SECS {
            return Ok(c.clone());
        }
    }
    if !allow_online {
        return Ok(Lyrics::default());
    }
    let found = lookup(base, q)?;
    let l = found.unwrap_or(Lyrics { fetched: now(), ..Default::default() });
    let _ = fs::create_dir_all(root);
    if let Ok(b) = serde_json::to_vec(&l) {
        let _ = write_atomic(&file, &b);
    }
    Ok(l)
}
