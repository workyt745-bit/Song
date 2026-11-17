//! Tests the artist photo fetcher against a fake local server (no real internet needed).

use pulse_lib::artists::{get_info, Endpoints};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;

type Reply = (u16, &'static str, Vec<u8>);

struct Mock {
    base: String,
    hits: Arc<AtomicUsize>,
}

fn jpeg(w: u32, h: u32, seed: u32) -> Vec<u8> {
    let img = image::RgbImage::from_fn(w, h, |x, y| image::Rgb([((x + seed * 40) % 256) as u8, ((y + seed * 90) % 256) as u8, (seed * 60 % 256) as u8]));
    let mut out = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85);
    img.write_with_encoder(enc).unwrap();
    out
}

fn json(s: String) -> Reply {
    (200, "application/json", s.into_bytes())
}

fn start(handler: impl Fn(&str, &str) -> Option<Reply> + Send + Sync + 'static) -> Mock {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let hits = Arc::new(AtomicUsize::new(0));
    let (h2, b2) = (hits.clone(), base.clone());
    let handler = Arc::new(handler);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { continue };
            let (handler, hits, base) = (handler.clone(), h2.clone(), b2.clone());
            thread::spawn(move || {
                let mut buf = vec![0u8; 8192];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let line = req.lines().next().unwrap_or("");
                let target = line.split_whitespace().nth(1).unwrap_or("/").to_string();
                hits.fetch_add(1, Ordering::SeqCst);
                let (code, ctype, body) = handler(&target, &base).unwrap_or((404, "text/plain", b"nope".to_vec()));
                let head = format!("HTTP/1.1 {code} X\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = s.write_all(head.as_bytes());
                let _ = s.write_all(&body);
            });
        }
    });
    Mock { base, hits }
}

fn endpoints(base: &str) -> Endpoints {
    Endpoints { audiodb: format!("{base}/adb"), deezer: format!("{base}/dz"), wiki: format!("{base}/wiki"), commons: format!("{base}/commons") }
}

fn tmp(name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("pulse-artists-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    p
}

fn full_server() -> Mock {
    start(|target, base| {
        if target.starts_with("/adb/search.php") {
            if target.contains("Taylor") {
                return Some(json(format!(
                    r#"{{"artists":[{{"strArtist":"Taylor Swift","strBiographyEN":"Taylor is a singer. She writes songs.","strArtistFanart":"{b}/img/1","strArtistFanart2":"{b}/img/2","strArtistFanart3":"{b}/img/3","strArtistFanart4":"{b}/img/1","strArtistWideThumb":"{b}/img/huge","strArtistThumb":"{b}/img/big"}}]}}"#,
                    b = base
                )));
            }
            if target.contains("Okoro") {
                return Some(json(r#"{"artists":[{"strArtist":"Somebody Else","strBiographyEN":"Wrong person."}]}"#.into()));
            }
            return Some(json(r#"{"artists":null}"#.into()));
        }
        if target.starts_with("/dz/search/artist") && target.contains("Okoro") {
            return Some(json(format!(r#"{{"data":[{{"name":"Okoro","picture_xl":"{}/img/2"}}]}}"#, base)));
        }
        match target {
            "/img/1" => Some((200, "image/jpeg", jpeg(1600, 900, 1))),
            "/img/2" => Some((200, "image/jpeg", jpeg(1280, 720, 2))),
            "/img/3" => Some((200, "image/jpeg", jpeg(1000, 1000, 3))),
            "/img/big" => Some((200, "image/jpeg", jpeg(3200, 2000, 4))),
            "/img/huge" => Some((200, "image/jpeg", vec![0u8; 5 * 1024 * 1024])),
            _ => None,
        }
    })
}

#[test]
fn downloads_shrinks_and_caches() {
    let m = full_server();
    let root = tmp("full");
    let ep = endpoints(&m.base);
    let info = get_info(&root, "Taylor Swift", &ep).expect("online");
    assert!(info.bio.starts_with("Taylor is a singer."));
    // 3 fanarts + big thumb; the duplicate and the 5 MB file are skipped.
    assert_eq!(info.images.len(), 4, "images: {:?}", info.images);
    assert_eq!(info.credit, "TheAudioDB");
    let dir = pulse_lib::artists::dir_for(&root, "Taylor Swift");
    for f in &info.images {
        let p = dir.join(f);
        let (w, h) = image::image_dimensions(&p).unwrap();
        assert!(w.max(h) <= 1200, "{f} is {w}x{h}");
        assert!(std::fs::metadata(&p).unwrap().len() < 600_000, "{f} is small");
    }
    // The 3200x2000 photo was shrunk, keeping its shape.
    let (w, h) = image::image_dimensions(dir.join("4.jpg")).unwrap();
    assert_eq!((w, h), (1200, 750));

    // Second time: straight from disk, no internet at all.
    let before = m.hits.load(Ordering::SeqCst);
    let again = get_info(&root, "taylor  swift", &ep).unwrap();
    assert_eq!(again.images, info.images);
    assert_eq!(m.hits.load(Ordering::SeqCst), before, "no requests when cached");
    eprintln!("requests for first fetch: {before}");
}

#[test]
fn wrong_artist_is_ignored_and_deezer_fills_in() {
    let m = full_server();
    let root = tmp("okoro");
    let info = get_info(&root, "Okoro", &endpoints(&m.base)).unwrap();
    assert_eq!(info.bio, "", "the wrong person's biography must not be used");
    assert_eq!(info.images.len(), 1);
    assert_eq!(info.credit, "Deezer");
}

#[test]
fn nothing_found_is_remembered() {
    let m = full_server();
    let root = tmp("nobody");
    let ep = endpoints(&m.base);
    let info = get_info(&root, "Nobody Famous", &ep).unwrap();
    assert!(info.images.is_empty() && info.bio.is_empty());
    let before = m.hits.load(Ordering::SeqCst);
    get_info(&root, "Nobody Famous", &ep).unwrap();
    assert_eq!(m.hits.load(Ordering::SeqCst), before, "does not ask again right away");
}

#[test]
fn offline_gives_an_error_and_saves_nothing() {
    let root = tmp("offline");
    // Nothing listens on port 1.
    let ep = endpoints("http://127.0.0.1:1");
    let err = get_info(&root, "Taylor Swift", &ep).unwrap_err();
    assert!(err.contains("offline"), "{err}");
    let dir = pulse_lib::artists::dir_for(&root, "Taylor Swift");
    assert!(!dir.join("info.json").exists(), "a failed try must not be cached");
}

#[test]
fn wikipedia_gives_bio_and_photo_when_others_have_nothing() {
    let m = start(|target, base| {
        if target.starts_with("/adb/") {
            return Some(json(r#"{"artists":null}"#.into()));
        }
        if target.starts_with("/wiki/page/summary/Mac_Miller") {
            return Some(json(format!(r#"{{"type":"standard","description":"American rapper and producer","extract":"Mac Miller was a rapper.","originalimage":{{"source":"{base}/img/a"}}}}"#)));
        }
        if target.starts_with("/wiki/page/summary/Paris") {
            return Some(json(r#"{"type":"standard","description":"Capital of France","extract":"A city."}"#.into()));
        }
        if target == "/img/a" {
            return Some((200, "image/jpeg", jpeg(900, 900, 5)));
        }
        None
    });
    let root = tmp("wiki");
    let ep = endpoints(&m.base);
    let info = get_info(&root, "Mac Miller", &ep).unwrap();
    assert_eq!(info.bio, "Mac Miller was a rapper.");
    assert_eq!(info.images.len(), 1);
    assert_eq!(info.credit, "Wikipedia");
    // A page that is not about a musician is rejected.
    let p = get_info(&root, "Paris", &ep).unwrap();
    assert!(p.bio.is_empty());
}

fn commons_server() -> Mock {
    start(|target, base| {
        if target.starts_with("/commons") {
            let mut pages = String::new();
            for i in 1..=14 {
                pages.push_str(&format!(
                    r#""{i}":{{"title":"File:Taylor Swift live {i}.jpg","index":{i},"imageinfo":[{{"mime":"image/jpeg","width":3000,"height":2000,"thumburl":"{base}/img/{i}","url":"{base}/orig/{i}"}}]}},"#
                ));
            }
            pages.push_str(&format!(r#""50":{{"title":"File:Taylor Swift album cover.jpg","index":50,"imageinfo":[{{"mime":"image/jpeg","width":3000,"height":2000,"thumburl":"{base}/img/1"}}]}},"#));
            pages.push_str(&format!(r#""51":{{"title":"File:Somebody Else on stage.jpg","index":51,"imageinfo":[{{"mime":"image/jpeg","width":3000,"height":2000,"thumburl":"{base}/img/2"}}]}},"#));
            pages.push_str(&format!(r#""52":{{"title":"File:Taylor Swift tiny.jpg","index":52,"imageinfo":[{{"mime":"image/jpeg","width":300,"height":200,"thumburl":"{base}/img/3"}}]}},"#));
            pages.push_str(&format!(r#""53":{{"title":"File:Taylor Swift drawing.svg","index":53,"imageinfo":[{{"mime":"image/svg+xml","width":3000,"height":2000,"thumburl":"{base}/img/4"}}]}}"#));
            return Some(json(format!(r#"{{"query":{{"pages":{{{pages}}}}}}}"#)));
        }
        if let Some(n) = target.strip_prefix("/img/") {
            let n: u32 = n.parse().unwrap_or(1);
            return Some((200, "image/jpeg", jpeg(1500 + n * 10, 1000, n)));
        }
        None
    })
}

#[test]
fn commons_gives_many_photos_in_parallel_and_skips_junk() {
    let m = commons_server();
    let root = tmp("commons");
    let ep = endpoints(&m.base);
    let t = std::time::Instant::now();
    let info = get_info(&root, "Taylor Swift", &ep).expect("online");
    eprintln!("commons fetch took {:?}", t.elapsed());
    assert_eq!(info.images.len(), 12, "capped at 12: {:?}", info.images);
    assert!(info.credit.contains("Wikimedia Commons"));
    let before = m.hits.load(Ordering::SeqCst);
    let again = get_info(&root, "Taylor Swift", &ep).unwrap();
    assert_eq!(again.images.len(), 12);
    assert_eq!(m.hits.load(Ordering::SeqCst), before, "cached: no more requests");
}

#[test]
fn old_two_photo_cache_is_refreshed_but_kept_when_offline() {
    let m = commons_server();
    let root = tmp("stale");
    let dir = pulse_lib::artists::dir_for(&root, "Taylor Swift");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("1.jpg"), jpeg(800, 600, 9)).unwrap();
    std::fs::write(dir.join("2.jpg"), jpeg(800, 600, 8)).unwrap();
    // The way the previous Pulse version saved it (no "ver" field).
    std::fs::write(dir.join("info.json"), r#"{"name":"Taylor Swift","bio":"old bio","credit":"Deezer","images":["1.jpg","2.jpg"],"fetched":1}"#).unwrap();
    // Offline: the old photos are still shown.
    let dead = Endpoints { audiodb: "http://127.0.0.1:1/a".into(), deezer: "http://127.0.0.1:1/d".into(), wiki: "http://127.0.0.1:1/w".into(), commons: "http://127.0.0.1:1/c".into() };
    assert_eq!(get_info(&root, "Taylor Swift", &dead).unwrap().images.len(), 2);
    // Online: refreshed to a full set.
    let info = get_info(&root, "Taylor Swift", &endpoints(&m.base)).unwrap();
    assert_eq!(info.images.len(), 12);
}
