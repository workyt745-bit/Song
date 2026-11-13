/* Core: platform layer, persistent store, library index, helpers, virtual list.
   Plain JavaScript, no framework, no dependencies: small memory footprint. */
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const icon = (name, cls = "") => `<svg class="ico ${cls}"><use href="#i-${name}"/></svg>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
function fmtTotal(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h >= 1) return `${h} hr ${m} min`;
  return `${Math.max(1, m)} min`;
}
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many || one + "s"}`;

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* ---------- Platform layer: real app (Tauri) or browser demo ---------- */
const TAURI = window.__TAURI__;
const IS_APP = !!(TAURI && TAURI.core);
const invoke = IS_APP ? TAURI.core.invoke : (cmd, args) => demo.invoke(cmd, args);
const fileUrl = IS_APP ? TAURI.core.convertFileSrc : (p) => p;

/* ---------- Persistent store (playlists, likes, settings) ---------- */
const store = { photos: true, lyrics: true, likes: [], playlists: [], plays: {}, recent: [], vol: 0.8, shuffle: false, repeat: 0, last: null };
let saveTimer = 0;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const json = JSON.stringify(store);
    if (IS_APP) invoke("save_store", { json }).catch(() => {});
    else try { localStorage.setItem("pulse-store", json); } catch (_) {}
  }, 500);
}
async function loadStore() {
  let raw = "";
  try { raw = IS_APP ? await invoke("load_store") : localStorage.getItem("pulse-store") || ""; } catch (_) {}
  if (raw) { try { Object.assign(store, JSON.parse(raw)); } catch (_) {} }
}

/* ---------- Library ---------- */
const lib = {
  songs: [], byId: new Map(), albums: [], artists: [], albumById: new Map(), artistById: new Map(),
  folders: [], files: [], coversDir: "", sep: "/", isDemo: false,
};

const primaryArtist = (s) => (s.split(";")[0] || s).trim() || "Unknown Artist";
const allArtists = (s) => s.split(";").map((x) => x.trim()).filter(Boolean);
const artistLabel = (s) => allArtists(s).join(", ") || "Unknown Artist";

const coverCache = new Map();
function coverUrl(key) {
  if (!key) return "";
  if (key.startsWith("data:") || key.startsWith("blob:")) return key; // browser preview
  let u = coverCache.get(key);
  if (!u) {
    u = fileUrl(lib.coversDir + lib.sep + key + ".jpg");
    coverCache.set(key, u);
  }
  return u;
}

function buildIndex(songs) {
  lib.songs = songs;
  lib.byId = new Map();
  const albums = new Map(), artists = new Map();
  for (const s of songs) {
    lib.byId.set(s.id, s);
    s._pa = primaryArtist(s.artist);
    s._k = (s.title + " " + s.artist + " " + s.album).toLowerCase();
    const owner = s.album_artist || s._pa;
    const akey = owner + "\u0001" + s.album;
    let a = albums.get(akey);
    if (!a) {
      a = { id: "al" + hash(akey).toString(36), name: s.album, artist: owner, year: 0, songs: [], cover: null, color: "", added: 0 };
      albums.set(akey, a);
    }
    a.songs.push(s);
    s._album = a;
    if (!a.cover && s.cover) { a.cover = s.cover; a.color = s.color; }
    if (s.year && !a.year) a.year = s.year;
    if (s.mtime > a.added) a.added = s.mtime;
    for (const name of allArtists(s.artist).length ? allArtists(s.artist) : ["Unknown Artist"]) {
      let r = artists.get(name);
      if (!r) {
        r = { id: "ar" + hash(name).toString(36), name, songs: [], albums: new Set(), cover: null, color: "" };
        artists.set(name, r);
      }
      r.songs.push(s);
      r.albums.add(a);
    }
  }
  lib.albums = [...albums.values()];
  for (const a of lib.albums) {
    a.songs.sort((x, y) => (x.disc - y.disc) || (x.track - y.track) || collator.compare(x.title, y.title));
    a.duration = a.songs.reduce((t, s) => t + s.duration, 0);
  }
  lib.albums.sort((x, y) => collator.compare(x.name, y.name));
  lib.artists = [...artists.values()];
  for (const r of lib.artists) {
    r.albums = [...r.albums].sort((x, y) => (y.year - x.year) || collator.compare(x.name, y.name));
    const withCover = r.albums.find((a) => a.cover);
    if (withCover) { r.cover = withCover.cover; r.color = withCover.color; }
    r.duration = r.songs.reduce((t, s) => t + s.duration, 0);
  }
  lib.artists.sort((x, y) => collator.compare(x.name, y.name));
  lib.albumById = new Map(lib.albums.map((a) => [a.id, a]));
  lib.artistById = new Map(lib.artists.map((a) => [a.id, a]));
  lib.sorted = songs.slice().sort((a, b) => collator.compare(a.title, b.title));
}

/* ---------- Cover art element ---------- */
function coverEl(cls) {
  const d = el("div", "cover " + (cls || ""));
  d.innerHTML = `<div class="ph">${icon("note")}</div><img alt="" decoding="async" loading="lazy" hidden>`;
  return d;
}
function setCover(d, key, seed, letter) {
  const img = d.lastElementChild, ph = d.firstElementChild;
  const url = coverUrl(key);
  if (url) {
    if (img.getAttribute("src") !== url) img.src = url;
    img.hidden = false;
    ph.hidden = true;
  } else {
    img.hidden = true;
    img.removeAttribute("src");
    ph.hidden = false;
    const h = hash(seed || "x") % 360;
    ph.style.background = `linear-gradient(135deg, hsl(${h} 42% 30%), hsl(${(h + 48) % 360} 46% 20%))`;
    if (letter) ph.innerHTML = `<span style="font-size:clamp(18px,40%,64px);font-weight:700;color:rgba(255,255,255,.7)">${esc(letter)}</span>`;
    else if (!ph.firstElementChild || ph.firstElementChild.tagName === "SPAN") ph.innerHTML = icon("note");
  }
}

/* ---------- Virtual list: only the rows on screen exist in the DOM ---------- */
function VList({ scroller, host, count, h, create, bind, overscan = 6 }) {
  const pool = [];
  let raf = 0;
  host.classList.add("vl");
  host.style.height = count * h + "px";

  function hostTop() {
    return host.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }
  function update(force) {
    raf = 0;
    const top = scroller.scrollTop - hostTop();
    const view = scroller.clientHeight;
    const first = clamp(Math.floor(top / h) - overscan, 0, Math.max(0, count - 1));
    const last = clamp(Math.ceil((top + view) / h) + overscan, -1, count - 1);
    const live = new Set();
    for (const it of pool) if (it.i >= first && it.i <= last) live.add(it.i);
    const free = pool.filter((it) => !(it.i >= first && it.i <= last));
    for (let i = first; i <= last; i++) {
      if (live.has(i) && !force) continue;
      let it = live.has(i) ? pool.find((p) => p.i === i) : free.pop();
      if (!it) {
        it = { el: create(), i: -1 };
        host.appendChild(it.el);
        pool.push(it);
      }
      it.i = i;
      it.el._i = i;
      it.el.style.transform = `translateY(${i * h}px)`;
      it.el.hidden = false;
      bind(it.el, i);
    }
    for (const it of free) { it.el.hidden = true; it.i = -1; }
  }
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(() => update(false)); };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  const ro = new ResizeObserver(onScroll);
  ro.observe(scroller);
  update(false);
  return {
    rebind() { update(true); },
    setCount(n) { count = n; host.style.height = n * h + "px"; update(true); },
    setRowHeight(nh) { h = nh; host.style.height = count * h + "px"; update(true); },
    destroy() { scroller.removeEventListener("scroll", onScroll); ro.disconnect(); cancelAnimationFrame(raf); },
  };
}

/* ---------- Toast ---------- */
let toastTimer = 0;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  t.style.animation = "none"; t.offsetWidth; t.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2400);
}

/* ---------- Context menu ---------- */
function openMenu(x, y, items) {
  const m = $("#menu");
  m.innerHTML = "";
  for (const it of items) {
    if (it === "-") { m.appendChild(el("hr")); continue; }
    if (it.label && !it.run) { m.appendChild(el("div", "m-label", esc(it.label))); continue; }
    const b = el("button", it.danger ? "danger" : "", (it.icon ? icon(it.icon) : "") + `<span>${esc(it.label)}</span>`);
    b.addEventListener("click", () => { closeMenu(); it.run(); });
    m.appendChild(b);
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = clamp(x, 8, innerWidth - r.width - 8) + "px";
  m.style.top = clamp(y, 8, innerHeight - r.height - 8) + "px";
}
function closeMenu() { $("#menu").hidden = true; }
addEventListener("pointerdown", (e) => { if (!e.target.closest("#menu")) closeMenu(); }, true);
addEventListener("blur", closeMenu);

/* ---------- Modal ---------- */
function openModal(node) {
  const m = $("#modal");
  m.innerHTML = "";
  m.appendChild(node);
  m.hidden = false;
  m.onpointerdown = (e) => { if (e.target === m) closeModal(); };
  const f = node.querySelector("input, button.primary");
  if (f) setTimeout(() => f.focus(), 0);
}
function closeModal() { $("#modal").hidden = true; $("#modal").innerHTML = ""; }

/* ---------- Browser demo data (only used when opened outside the app) ---------- */
const demo = {
  wav: "",
  invoke(cmd, args) {
    if (cmd === "load_library") return Promise.resolve({ folders: ["D:\\Music (demo)"], songs: demo.songs(), covers_dir: "/demo" });
    if (cmd === "scan_library") return Promise.resolve(demo.songs());
    if (cmd === "load_store") return Promise.resolve("");
    if (cmd === "lyrics_for") return new Promise((res) => setTimeout(() => res(demo.lyrics(args)), 700));
    if (cmd === "artist_info") return new Promise((res) => setTimeout(() => res(demo.artist(args.name)), 1100));
    return Promise.resolve();
  },
  songs() {
    const data = [
      ["Neon Harbour", "Vela Marsh", 2022, ["Static Bloom", "Glass Tide", "Harbour Lights", "Low Orbit", "Paper Satellites", "After the Rain Machine", "Violet Hour", "Slow Drift"], 262],
      ["Midnight Atlas", "The Quiet Engines", 2020, ["Coordinates", "North of Nowhere", "Cartographer", "Dust Roads", "Signal Fire", "Atlas", "Last Train Home"], 238],
      ["Golden Static", "Juno Karma", 2023, ["Sunday Voltage", "Honey Circuit", "Golden Static", "Pink Noise", "Wildflower Code", "Tangerine", "Overgrown", "Lighthouse", "Afterglow"], 201],
      ["Salt & Cedar", "Marlow Finch", 2019, ["Salt & Cedar", "River Hymn", "Weathered", "Porchlight", "Thaw", "Field Notes"], 215],
      ["Afterimage", "Vela Marsh", 2024, ["Afterimage", "Ghost Frequency", "Cold Open", "Mirror Lake", "Half Light", "Undertow"], 247],
      ["Concrete Garden", "Okoro", 2021, ["Concrete Garden", "Rooftops", "Bassline Weather", "Monsoon", "Marigold", "Night Bus", "Pressure", "Kintsugi"], 189],
      ["Slow Fires", "Juno Karma", 2018, ["Slow Fires", "Ember", "Ashes Remember", "Candle Math", "Hearth"], 226],
      ["Lowlands", "The Quiet Engines", 2017, ["Lowlands", "Fog Horn", "Tide Table", "Salt Flats", "Hollow Pines", "Drift Wood", "Kerosene"], 244],
    ];
    const out = [];
    let t = Date.now() / 1000 - 86400 * 40;
    data.forEach(([album, artist, year, tracks, base], ai) => {
      const h = (ai * 47 + 250) % 360;
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='hsl(${h} 70% 55%)'/><stop offset='1' stop-color='hsl(${(h + 60) % 360} 70% 28%)'/></linearGradient></defs><rect width='100' height='100' fill='url(#g)'/><circle cx='${30 + ai * 7}' cy='${70 - ai * 4}' r='${22 + ai * 2}' fill='hsl(${(h + 150) % 360} 80% 70%)' opacity='.35'/><circle cx='72' cy='30' r='14' fill='#fff' opacity='.18'/></svg>`;
      const cover = "data:image/svg+xml;utf8," + encodeURIComponent(svg);
      const col = `hsl(${h} 70% 55%)`;
      const rgb = hslToHex(h, 70, 55);
      tracks.forEach((title, i) => {
        t += 3600;
        out.push({
          id: "d" + ai + "_" + i, path: "demo", title, artist: artist + (i === 2 && artist !== "Okoro" ? ";Okoro" : ""), album, album_artist: artist,
          track: i + 1, disc: 1, year, duration: base - 40 + ((i * 37 + ai * 11) % 90), cover, color: rgb, mtime: Math.floor(t), size: 1,
        });
      });
    });
    return out;
  },
  /** Pretend artist photos for the browser preview (the real app downloads real ones). */
  artist(name) {
    const h = hash(name) % 360;
    const scene = (i) => {
      const a = (h + i * 47) % 360, b = (a + 70) % 360;
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 900'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='hsl(${a} 65% 38%)'/><stop offset='1' stop-color='hsl(${b} 70% 16%)'/></linearGradient><radialGradient id='r' cx='.5' cy='.5' r='.5'><stop offset='0' stop-color='hsl(${(a + 160) % 360} 90% 70%)' stop-opacity='.55'/><stop offset='1' stop-color='hsl(${(a + 160) % 360} 90% 70%)' stop-opacity='0'/></radialGradient></defs><rect width='1600' height='900' fill='url(#g)'/><circle cx='${900 + i * 120}' cy='${300 + i * 60}' r='${380 + i * 30}' fill='url(#r)'/><ellipse cx='${1050 - i * 90}' cy='760' rx='520' ry='120' fill='#000' opacity='.28'/><circle cx='${1180 - i * 70}' cy='${330 + i * 25}' r='110' fill='hsl(${(a + 20) % 360} 40% 78%)' opacity='.85'/><rect x='${1080 - i * 70}' y='${430 + i * 25}' width='200' height='420' rx='90' fill='hsl(${(a + 20) % 360} 35% 22%)' opacity='.9'/></svg>`;
      return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
    };
    return {
      name, credit: "Demo art",
      images: [0, 1, 2, 3].map(scene),
      bio: `${name} is a made-up artist for the browser preview. In the Pulse desktop app this space shows a real biography, pulled once from a free music database and kept on your PC.\n\nThe photos behind this text change every few seconds while a song plays. Only two photos are held in memory at any time, and they are saved on disk after the first visit, so opening this tab again uses no internet at all.\n\nSongs by ${name} keep rolling while you read; use the dots below to jump to a photo you like.`,
    };
  },
  /** Pretend timed lyrics for the browser preview. */
  lyrics(a) {
    const words = ["Midnight air on the empty road", "Every light is a sign you gave me", "I keep the radio low", "Sing it back when the chorus comes", "We were louder than the city then", "Hold the note, let it carry home", "", "Nothing here is real, but listen", "The real app shows the real words", "Found once online, then saved on your PC", "Click any line to jump to it", "And the bright one follows the song"];
    const step = Math.max(3, Math.min(6, (a.duration || 200) / (words.length + 2)));
    return { synced: words.map((text, i) => ({ t: 4 + i * step, text })), plain: words.join("\n"), instrumental: false, source: "Demo lyrics", fetched: 0 };
  },
  audioUrl() {
    if (demo.wav) return demo.wav;
    // 8 kHz mono 8-bit silence-ish tone, 5 minutes, so seeking and progress work in the demo.
    const rate = 8000, n = rate * 300, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF"); v.setUint32(4, 36 + n, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true);
    v.setUint16(34, 8, true); w(36, "data"); v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) v.setUint8(44 + i, 128 + Math.round(Math.sin(i / 14) * 2));
    demo.wav = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
    return demo.wav;
  },
};
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return "#" + [f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
