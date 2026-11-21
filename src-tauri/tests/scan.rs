use pulse_lib::library::scan;
use std::path::PathBuf;

/// Run with: PULSE_TEST_MUSIC=/path/to/music PULSE_TEST_COVERS=/tmp/covers cargo test -- --nocapture
#[test]
fn scans_real_files() {
    let (Ok(music), Ok(covers)) = (std::env::var("PULSE_TEST_MUSIC"), std::env::var("PULSE_TEST_COVERS")) else {
        eprintln!("skipped: set PULSE_TEST_MUSIC and PULSE_TEST_COVERS");
        return;
    };
    let covers = PathBuf::from(covers);
    let first = scan(&[music.clone()], &[], vec![], &covers, &|_, _| {});
    for s in &first {
        eprintln!("{:<12} | {:<18} | {:<12} | aa={:<11} | #{} y{} | {:.1}s | cover={:?}", s.title, s.artist, s.album, s.album_artist, s.track, s.year, s.duration, s.cover);
    }
    assert_eq!(first.len(), 8, "7 playable + 1 broken (kept with filename title)");
    let t1 = first.iter().find(|s| s.title == "Track 1").unwrap();
    assert_eq!(t1.artist, "Artist One;Guest");
    assert_eq!(t1.album_artist, "Artist One");
    assert_eq!(t1.track, 1);
    assert!(t1.duration > 19.0 && t1.duration < 23.0);
    assert!(t1.cover.is_some());
    eprintln!("colors: {} / {:?}", t1.color, first.iter().find(|s| s.title=="Flac Song").map(|s| &s.color));
    assert!(t1.color.starts_with('#') && t1.color.len() == 7);
    let thumb = covers.join(format!("{}.jpg", t1.cover.as_ref().unwrap()));
    assert!(thumb.exists());
    assert!(std::fs::metadata(&thumb).unwrap().len() < 60_000, "thumbnail is small");
    // 3 tracks share one cover, so only 2 thumbnails exist in total.
    let n = std::fs::read_dir(&covers).unwrap().count();
    assert_eq!(n, 2);
    // Second scan reuses the cache entirely.
    let t = std::time::Instant::now();
    let second = scan(&[music], &[], first.clone(), &covers, &|_, _| {});
    eprintln!("rescan: {:?}", t.elapsed());
    assert_eq!(second.len(), first.len());
}

#[test]
fn single_files_are_added_without_a_folder() {
    let Ok(music) = std::env::var("PULSE_TEST_MUSIC") else { return };
    let covers = std::env::temp_dir().join("pulse-single-covers");
    let one = format!("{music}/Album2/f.flac");
    let two = format!("{music}/Album1/t1.mp3");
    let notes = format!("{music}/Album1/notes.txt");
    let songs = scan(&[], &[one.clone(), two, notes, one], vec![], &covers, &|_, _| {});
    assert_eq!(songs.len(), 2, "two real songs; the .txt and the duplicate are ignored");
}

#[test]
fn small_cover_copies_are_made_for_old_covers() {
    let dir = std::env::temp_dir().join(format!("pulse-small-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    image::RgbImage::from_pixel(320, 320, image::Rgb([200, 80, 120])).save(dir.join("abc123.jpg")).unwrap();
    pulse_lib::library::backfill_small_covers(&dir);
    let small = image::open(dir.join("abc123_s.jpg")).expect("small copy exists");
    assert_eq!((small.width(), small.height()), (96, 96));
    // Running again must not create copies of copies.
    pulse_lib::library::backfill_small_covers(&dir);
    assert!(!dir.join("abc123_s_s.jpg").exists());
    let _ = std::fs::remove_dir_all(&dir);
}
