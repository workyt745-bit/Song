/* Browser preview only: lets you try Pulse with your own songs by picking a folder.
   Everything is read locally in the browser, nothing is uploaded.
   The desktop app does not use this file (its Rust back end does the same job). */
"use strict";

const AUDIO_RE = /\.(mp3|m4a|aac|flac|ogg|opus|wav)$/i;
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
const u32be = (b, o) => b[o] * 16777216 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u32le = (b, o) => b[o] + (b[o + 1] << 8) + (b[o + 2] << 16) + b[o + 3] * 16777216;
const synch = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
const num = (s) => parseInt(String(s).split("/")[0], 10) || 0;

/* ---------- Cover art: shrink to a small thumbnail and find its main colour ---------- */
const coverMap = new Map();
async function makeCover(bytes, mime) {
  if (!bytes || bytes.length < 100) return null;
  let h = bytes.length;
  for (let i = 0; i < Math.min(bytes.length, 4096); i += 7) h = Math.imul(h ^ bytes[i], 16777619);
  const key = "c" + (h >>> 0).toString(36) + bytes.length;
  if (coverMap.has(key)) return coverMap.get(key);
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: mime || "image/jpeg" }));
    const sc = Math.min(1, 320 / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * sc)), hh = Math.max(1, Math.round(bmp.height * sc));
    const c = document.createElement("canvas");
    c.width = w; c.height = hh;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, w, hh);
    bmp.close && bmp.close();
    // dominant colour: weight pixels by saturation and brightness
    const t = document.createElement("canvas");
    t.width = t.height = 24;
    const tg = t.getContext("2d", { willReadFrequently: true });
    tg.drawImage(c, 0, 0, 24, 24);
    const d = tg.getImageData(0, 0, 24, 24).data;
    let r = 0, gg = 0, b = 0, ws = 0, ar = 0, ag = 0, ab = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
      const sat = mx ? (mx - mn) / mx : 0, wt = sat * sat * (mx / 255) + 1e-4;
      r += d[i] * wt; gg += d[i + 1] * wt; b += d[i + 2] * wt; ws += wt;
      ar += d[i]; ag += d[i + 1]; ab += d[i + 2]; n++;
    }
    const [fr, fg, fb] = ws < 1 ? [ar / n, ag / n, ab / n] : [r / ws, gg / ws, b / ws];
    const color = "#" + [fr, fg, fb].map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.82));
    const out = { url: URL.createObjectURL(blob), color };
    coverMap.set(key, out);
    return out;
  } catch (_) {
    coverMap.set(key, null);
    return null;
  }
}

/* ---------- MP3: ID3 tags + duration ---------- */
function id3Text(b, enc) {
  let s;
  if (enc === 1 || enc === 2) {
    let le = enc === 1, off = 0;
    if (b[0] === 0xff && b[1] === 0xfe) { off = 2; le = true; }
    else if (b[0] === 0xfe && b[1] === 0xff) { off = 2; le = false; }
    s = new TextDecoder(le ? "utf-16le" : "utf-16be").decode(b.subarray(off));
  } else s = new TextDecoder(enc === 3 ? "utf-8" : "windows-1252").decode(b);
  return s.split("\0").map((x) => x.trim()).filter(Boolean).join(";");
}
async function readMp3(file, s) {
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  let audioStart = 0, picture = null;
  if (ascii(head, 0, 3) === "ID3") {
    const ver = head[3], size = synch(head, 6);
    audioStart = 10 + size;
    if (ver >= 3) {
      const tag = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
      let p = 0;
      if (head[5] & 0x40) p = ver === 4 ? synch(tag, 0) : u32be(tag, 0) + 4;
      while (p + 10 <= tag.length && tag[p] !== 0) {
        const id = ascii(tag, p, 4), fs = ver === 4 ? synch(tag, p + 4) : u32be(tag, p + 4);
        const body = tag.subarray(p + 10, p + 10 + fs);
        p += 10 + fs;
        if (!fs) continue;
        if (id[0] === "T" && id !== "TXXX") {
          const t = id3Text(body.subarray(1), body[0]);
          if (id === "TIT2" && t) s.title = t;
          else if (id === "TPE1" && t) s.artist = t;
          else if (id === "TALB" && t) s.album = t;
          else if (id === "TPE2" && t) s.album_artist = t;
          else if (id === "TRCK") s.track = num(t);
          else if (id === "TPOS") s.disc = num(t);
          else if ((id === "TDRC" || id === "TYER") && t) s.year = num(t.slice(0, 4));
        } else if (id === "APIC" && !picture) {
          const enc = body[0];
          let q = 1;
          while (q < body.length && body[q] !== 0) q++;
          const mime = ascii(body, 1, q - 1);
          q += 2; // skip terminator + picture type
          if (enc === 1 || enc === 2) { while (q + 1 < body.length && !(body[q] === 0 && body[q + 1] === 0)) q += 2; q += 2; }
          else { while (q < body.length && body[q] !== 0) q++; q++; }
          picture = { bytes: body.subarray(q), mime: mime.includes("/") ? mime : "image/jpeg" };
        }
      }
    }
  }
  // duration: exact from the Xing/Info header when present, else from the bitrate
  const buf = new Uint8Array(await file.slice(audioStart, audioStart + 8192).arrayBuffer());
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const v = (buf[i + 1] >> 3) & 3, layer = (buf[i + 1] >> 1) & 3, br = buf[i + 2] >> 4, sr = (buf[i + 2] >> 2) & 3;
    if (v === 1 || layer !== 1 || br === 0 || br === 15 || sr === 3) continue;
    const m1 = v === 3;
    const kbps = (m1 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[br];
    const rate = ([44100, 48000, 32000].map((x) => (m1 ? x : v === 2 ? x / 2 : x / 4)))[sr];
    const spf = m1 ? 1152 : 576, mono = buf[i + 3] >> 6 === 3;
    const x = i + 4 + (m1 ? (mono ? 17 : 32) : mono ? 9 : 17);
    const tagName = ascii(buf, x, 4);
    if ((tagName === "Xing" || tagName === "Info") && buf[x + 7] & 1) s.duration = (u32be(buf, x + 8) * spf) / rate;
    else s.duration = ((file.size - audioStart) * 8) / (kbps * 1000);
    break;
  }
  return picture;
}

/* ---------- FLAC ---------- */
async function readFlac(file, s) {
  const buf = new Uint8Array(await file.slice(0, Math.min(file.size, 6 * 1024 * 1024)).arrayBuffer());
  if (ascii(buf, 0, 4) !== "fLaC") return null;
  let p = 4, picture = null;
  while (p + 4 <= buf.length) {
    const last = buf[p] & 0x80, type = buf[p] & 0x7f, len = (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
    const b = buf.subarray(p + 4, p + 4 + len);
    p += 4 + len;
    if (type === 0 && b.length >= 18) {
      const rate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      const total = (b[13] & 15) * 4294967296 + u32be(b, 14);
      if (rate) s.duration = total / rate;
    } else if (type === 4) {
      let q = 4 + u32le(b, 0);
      const count = u32le(b, q); q += 4;
      for (let i = 0; i < count && q + 4 <= b.length; i++) {
        const l = u32le(b, q); q += 4;
        const kv = new TextDecoder().decode(b.subarray(q, q + l)); q += l;
        const eq = kv.indexOf("=");
        const k = kv.slice(0, eq).toUpperCase(), v = kv.slice(eq + 1).trim();
        if (k === "TITLE" && v) s.title = v;
        else if (k === "ARTIST" && v) s.artist = s.artist === "Unknown Artist" ? v : s.artist + ";" + v;
        else if (k === "ALBUM" && v) s.album = v;
        else if (k === "ALBUMARTIST" && v) s.album_artist = v;
        else if (k === "TRACKNUMBER") s.track = num(v);
        else if (k === "DISCNUMBER") s.disc = num(v);
        else if (k === "DATE" || k === "YEAR") s.year = num(v.slice(0, 4));
      }
    } else if (type === 6 && !picture) {
      let q = 4;
      const ml = u32be(b, q); q += 4;
      const mime = ascii(b, q, ml); q += ml;
      q += 4 + u32be(b, q); // description
      q += 16; // width, height, depth, colours
      const dl = u32be(b, q); q += 4;
      picture = { bytes: b.subarray(q, q + dl), mime };
    }
    if (last) break;
  }
  return picture;
}

/* ---------- M4A / AAC (MP4 tags) ---------- */
async function readM4a(file, s) {
  let pos = 0, moov = null;
  while (pos + 8 <= file.size) {
    const h = new Uint8Array(await file.slice(pos, pos + 16).arrayBuffer());
    let size = u32be(h, 0), hl = 8;
    if (size === 1) { size = u32be(h, 8) * 4294967296 + u32be(h, 12); hl = 16; }
    else if (size === 0) size = file.size - pos;
    if (ascii(h, 4, 4) === "moov") { moov = new Uint8Array(await file.slice(pos + hl, pos + size).arrayBuffer()); break; }
    if (size < 8) break;
    pos += size;
  }
  if (!moov) return null;
  let picture = null;
  const walk = (start, end, path) => {
    let p = start;
    while (p + 8 <= end) {
      const size = u32be(moov, p), name = ascii(moov, p + 4, 4);
      if (size < 8) break;
      const bodyStart = p + 8, bodyEnd = Math.min(end, p + size);
      if (name === "mvhd") {
        const v = moov[bodyStart];
        const ts = v === 1 ? u32be(moov, bodyStart + 20) : u32be(moov, bodyStart + 12);
        const dur = v === 1 ? u32be(moov, bodyStart + 24) * 4294967296 + u32be(moov, bodyStart + 28) : u32be(moov, bodyStart + 16);
        if (ts) s.duration = dur / ts;
      } else if (name === "moov" || name === "udta" || name === "ilst") walk(bodyStart, bodyEnd, name);
      else if (name === "meta") walk(bodyStart + 4, bodyEnd, name);
      else if (path === "ilst") {
        // each item holds a "data" atom: 8 header + 8 (flags, locale) then the value
        const dataAt = bodyStart + 8;
        if (dataAt + 8 <= bodyEnd && ascii(moov, bodyStart + 4, 4) === "data") {
          const v = moov.subarray(bodyStart + 16, bodyEnd);
          const text = () => new TextDecoder().decode(v).trim();
          if (name === "\u00a9nam") s.title = text() || s.title;
          else if (name === "\u00a9ART") s.artist = text() || s.artist;
          else if (name === "\u00a9alb") s.album = text() || s.album;
          else if (name === "aART") s.album_artist = text();
          else if (name === "\u00a9day") s.year = num(text().slice(0, 4));
          else if (name === "trkn" && v.length >= 6) s.track = (v[2] << 8) | v[3];
          else if (name === "disk" && v.length >= 6) s.disc = (v[2] << 8) | v[3];
          else if (name === "covr" && !picture) picture = { bytes: v, mime: v[0] === 0x89 ? "image/png" : "image/jpeg" };
        }
      }
      p += size;
    }
  };
  walk(0, moov.length, "root");
  return picture;
}

/* ---------- Fallback: ask the browser for the length ---------- */
function probeDuration(file) {
  return new Promise((resolve) => {
    const a = new Audio(), url = URL.createObjectURL(file);
    const done = (v) => { URL.revokeObjectURL(url); a.removeAttribute("src"); resolve(v); };
    a.preload = "metadata";
    a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 2500);
    a.src = url;
  });
}

async function readBrowserSong(file) {
  const path = file._path || file.webkitRelativePath || file.name;
  const stem = file.name.replace(/\.[^.]+$/, "");
  const s = {
    id: "b" + hash(path + ":" + file.size).toString(36), path, title: stem, artist: "Unknown Artist", album: "Unknown Album",
    album_artist: "", track: 0, disc: 0, year: 0, duration: 0, cover: null, color: "",
    mtime: Math.floor(file.lastModified / 1000), size: file.size, _file: file,
  };
  let pic = null;
  try {
    const ext = file.name.split(".").pop().toLowerCase();
    if (ext === "mp3") pic = await readMp3(file, s);
    else if (ext === "flac") pic = await readFlac(file, s);
    else if (ext === "m4a" || ext === "aac") pic = await readM4a(file, s);
  } catch (_) {}
  if (!s.duration) s.duration = await probeDuration(file);
  if (pic) {
    const c = await makeCover(pic.bytes, pic.mime);
    if (c) { s.cover = c.url; s.color = c.color; }
  }
  return s;
}

/* ---------- Import ---------- */
function resetPlayer() {
  P.list = []; P.base = []; P.i = -1;
  audio.pause();
  audio.removeAttribute("src");
  waveSeed = ""; for (const w of waves) w.shape = null;
  renderQueue(); renderNowPlaying(); renderPlayState(); setProgress(0);
  $$(".t-cur").forEach((e) => (e.textContent = "0:00"));
  $$(".t-dur").forEach((e) => (e.textContent = "0:00"));
  setAccent(null);
  closeNowPlaying();
}
let importing = false;
let pendingPlaylist = null; // a playlist that the next import should also add its songs to
/** Adds songs to what is already loaded. Demo songs are replaced by the first real ones. */
async function importBrowserFiles(all) {
  const target = pendingPlaylist;
  pendingPlaylist = null;
  if (importing) return toast("Still reading your songs. Try again in a moment.");
  const files = all.filter((f) => AUDIO_RE.test(f.name));
  if (!files.length) return toast("No songs found. Pulse plays MP3, M4A, FLAC, OGG and WAV.");
  importing = true;
  const box = $("#scan-status");
  box.hidden = false;
  const wasDemo = lib.isDemo;
  const have = new Set(wasDemo ? [] : lib.songs.map((s) => s.id));
  const fresh = [], every = [];
  const t0 = performance.now();
  try {
    for (let i = 0; i < files.length; i += 8) {
      const batch = await Promise.all(files.slice(i, i + 8).map(readBrowserSong));
      for (const s of batch) { every.push(s.id); if (!have.has(s.id)) { have.add(s.id); fresh.push(s); } }
      $("#scan-text").textContent = `Reading ${Math.min(i + 8, files.length).toLocaleString()} of ${files.length.toLocaleString()} songs`;
      $("#scan-fill").style.width = (Math.min(i + 8, files.length) / files.length) * 100 + "%";
    }
    if (!fresh.length) {
      if (target) return addToPlaylist(target, every);
      return toast("Those songs are already in your library.");
    }
    if (wasDemo) resetPlayer();
    lib.isDemo = false;
    const merged = (wasDemo ? [] : lib.songs).concat(fresh);
    lib.folders = uniq(merged.map((s) => s.path.split("/")[0]).filter((x) => x && x !== "demo"));
    buildIndex(merged);
    updateCounts();
    if (wasDemo) go({ t: "home" }, false); else { render(true); renderQueue(); }
    renderNowPlaying();
    if (target) addToPlaylist(target, every);
    else toast(`Added ${plural(fresh.length, "song")} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.error(e);
    toast("Couldn’t read some of those files.");
  } finally {
    importing = false;
    box.hidden = true;
  }
}

/** Reads dropped files and folders (folders are walked, however deep). */
async function handleBrowserDrop(entries, loose) {
  if (!entries.length) return importBrowserFiles(loose);
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      Object.defineProperty(f, "_path", { value: prefix + entry.name });
      out.push(f);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e, prefix + entry.name + "/");
      } while (batch.length);
    }
  };
  try { for (const e of entries) await walk(e, ""); } catch (e) { console.error(e); }
  importBrowserFiles(out);
}

/* Hidden inputs kept in the page: some browsers drop a loose input before "change" fires. */
const pickers = {};
function picker(kind) {
  if (pickers[kind]) return pickers[kind];
  const inp = document.createElement("input");
  inp.type = "file";
  inp.multiple = true;
  inp.hidden = true;
  if (kind === "folder") inp.webkitdirectory = true;
  else inp.accept = ".mp3,.m4a,.aac,.flac,.ogg,.opus,.wav,audio/*";
  inp.addEventListener("change", () => {
    const files = [...inp.files];
    inp.value = "";
    importBrowserFiles(files);
  });
  document.body.appendChild(inp);
  return (pickers[kind] = inp);
}
const pickBrowserFolder = () => picker("folder").click();
const pickBrowserFiles = () => picker("files").click();

function useDemoSongs() {
  resetPlayer();
  lib.isDemo = true;
  lib.folders = ["D:\\Music (demo)"];
  buildIndex(demo.songs());
  updateCounts();
  go({ t: "home" }, false);
}
