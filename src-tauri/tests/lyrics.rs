//! Tests the lyrics lookup against a fake local server.
use pulse_lib::lyrics::{clean_title, get, parse_lrc, Query};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;

fn start(handler: impl Fn(&str) -> Option<String> + Send + Sync + 'static) -> (String, Arc<AtomicUsize>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/api", l.local_addr().unwrap());
    let hits = Arc::new(AtomicUsize::new(0));
    let h2 = hits.clone();
    let handler = Arc::new(handler);
    thread::spawn(move || {
        for st in l.incoming() {
            let Ok(mut s) = st else { continue };
            let (handler, hits) = (handler.clone(), h2.clone());
            thread::spawn(move || {
                let mut buf = vec![0u8; 8192];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let target = req.lines().next().unwrap_or("").split_whitespace().nth(1).unwrap_or("/").to_string();
                hits.fetch_add(1, Ordering::SeqCst);
                let (code, body) = match handler(&target) { Some(b) => (200, b), None => (404, "{}".into()) };
                let head = format!("HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = s.write_all(head.as_bytes());
                let _ = s.write_all(body.as_bytes());
            });
        }
    });
    (base, hits)
}

fn tmp(n: &str) -> std::path::PathBuf {
    let p = std::env::temp_dir().join(format!("pulse-lyr-{n}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    p
}

const LRC: &str = "[ar:Taylor Swift]\\n[00:12.50]First line\\n[00:20.00]Second line\\n[01:05.25][02:00.00]Chorus";

#[test]
fn parses_timed_lines() {
    let l = parse_lrc("[ar:X]\n[00:12.50]First\n[01:05.25][02:00.00]Chorus\n[00:03.00]");
    assert_eq!(l.len(), 4);
    assert_eq!(l[0].text, "");
    assert!((l[1].t - 12.5).abs() < 0.01 && l[1].text == "First");
    assert!((l[3].t - 120.0).abs() < 0.01 && l[3].text == "Chorus");
    assert_eq!(clean_title("Love Story (Taylor's Version)"), "Love Story");
    assert_eq!(clean_title("Song - Remastered 2011"), "Song");
    assert_eq!(clean_title("Song (feat. Z) - Live"), "Song");
}

#[test]
fn finds_caches_and_does_not_ask_twice() {
    let (base, hits) = start(|t| {
        t.starts_with("/api/get?").then(|| format!(r#"{{"syncedLyrics":"{LRC}","plainLyrics":"First line\nSecond line","instrumental":false}}"#))
    });
    let dir = tmp("a");
    let q = Query { artist: "Taylor Swift", title: "Love Story", album: "Fearless", duration: 235.0, path: "/nowhere/x.mp3" };
    let l = get(&dir, &q, &base, true).unwrap();
    assert_eq!(l.synced.len(), 4);
    assert_eq!(l.synced[0].text, "First line");
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    let l2 = get(&dir, &q, &base, true).unwrap();
    assert_eq!(l2.synced.len(), 4);
    assert_eq!(hits.load(Ordering::SeqCst), 1, "second time must come from disk");
}

#[test]
fn search_fallback_rejects_wrong_artist_and_picks_matching_length() {
    let (base, _) = start(|t| {
        if t.starts_with("/api/search") {
            Some(r#"[{"artistName":"Someone Else","trackName":"Hello","duration":200,"plainLyrics":"wrong"},
                     {"artistName":"Adele","trackName":"Hello","duration":120,"plainLyrics":"too short version"},
                     {"artistName":"Adele","trackName":"Hello","duration":295,"plainLyrics":"right one"}]"#.to_string())
        } else { None }
    });
    let q = Query { artist: "Adele", title: "Hello (Remastered)", album: "25", duration: 295.0, path: "/nowhere/x.mp3" };
    let l = get(&tmp("b"), &q, &base, true).unwrap();
    assert_eq!(l.plain, "right one");
    let q2 = Query { artist: "Nobody", title: "Hello", album: "", duration: 295.0, path: "/nowhere/x.mp3" };
    assert!(get(&tmp("b2"), &q2, &base, true).unwrap().is_empty());
}

#[test]
fn not_found_is_remembered_and_offline_is_not() {
    let (base, hits) = start(|_| None);
    let dir = tmp("c");
    let q = Query { artist: "A", title: "B", album: "", duration: 100.0, path: "/nowhere/x.mp3" };
    assert!(get(&dir, &q, &base, true).unwrap().is_empty());
    let n = hits.load(Ordering::SeqCst);
    assert!(get(&dir, &q, &base, true).unwrap().is_empty());
    assert_eq!(hits.load(Ordering::SeqCst), n, "a miss is remembered for a while");

    let dir2 = tmp("d");
    let err = get(&dir2, &q, "http://127.0.0.1:1/api", true).unwrap_err();
    assert!(err.contains("offline"));
    assert!(!dir2.exists() || std::fs::read_dir(&dir2).unwrap().count() == 0);
}

#[test]
fn local_lrc_file_wins_and_needs_no_internet() {
    let dir = tmp("e");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("song.lrc"), "[00:01.00]hello\n[00:05.00]world").unwrap();
    let song = dir.join("song.mp3");
    let q = Query { artist: "A", title: "B", album: "", duration: 10.0, path: song.to_str().unwrap() };
    let l = get(&dir.join("cache"), &q, "http://127.0.0.1:1/api", false).unwrap();
    assert_eq!(l.synced.len(), 2);
}
