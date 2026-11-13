/* Player: audio engine, queue, waveform scrubbers, accent colour, full screen view, media keys. */
"use strict";

const audio = new Audio();
audio.preload = "metadata";

const P = { list: [], base: [], i: -1, errors: 0, counted: false, lastSave: 0, seeking: false };
let likeSet = new Set();
let preMute = 0.8;

const curSong = () => lib.byId.get(P.list[P.i]) || null;
const isPlaying = () => !audio.paused && !audio.ended;
let objUrl = "";
function srcOf(s) {
  if (IS_APP) return fileUrl(s.path);
  if (!s._file) return demo.audioUrl();
  if (objUrl) URL.revokeObjectURL(objUrl);
  return (objUrl = URL.createObjectURL(s._file));
}
const $$ = (s) => document.querySelectorAll(s);

/* ---------- Accent colour (tinted by the playing album) ---------- */
const DEFAULT_ACCENT = "#a99cff";
let accentNow = DEFAULT_ACCENT;
function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return [h, s * 100, l * 100];
}
function tuneColor(hex) {
  if (hex && /^#[0-9a-f]{6}$/i.test(hex)) {
    const [h, s, l] = hexToHsl(hex);
    if (s > 14) return hslToHex(h, clamp(s, 48, 88), clamp(l, 60, 72));
  }
  return DEFAULT_ACCENT;
}
function setAccent(hex) {
  accentNow = tuneColor(hex);
  document.documentElement.style.setProperty("--accent", accentNow);
  drawWaves();
}

/* ---------- Waveform scrubbers (small bar and full screen) ---------- */
// Stylised bars generated from the song itself: the same song always shows the same shape.
function waveShape(seed, n) {
  let a = hash(seed) || 1;
  const rnd = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const knots = Array.from({ length: Math.ceil(n / 7) + 2 }, rnd);
  return Array.from({ length: n }, (_, i) => {
    const x = i / 7, k = Math.floor(x), f = x - k;
    const slow = knots[k] * (1 - f) + knots[k + 1] * f;
    const env = 0.62 + 0.38 * Math.sqrt(Math.sin(Math.PI * (i + 0.5) / n));
    return clamp((0.28 + 0.72 * (0.62 * slow + 0.38 * rnd())) * env, 0.12, 1);
  });
}
const waves = [];
let waveSeed = "";
function createWave(wrap) {
  const big = wrap.hasAttribute("data-big");
  const w = { wrap, big, bar: big ? 4 : 3, gap: big ? 3 : 2, shape: null };
  w.base = el("canvas"); w.fill = el("canvas", "wf"); w.tip = el("div", "wave-tip", "0:00");
  wrap.append(w.base, w.fill, w.tip);
  const ratioAt = (e) => clamp((e.clientX - wrap.getBoundingClientRect().left) / wrap.clientWidth, 0, 1);
  const dur = () => audio.duration || (curSong() ? curSong().duration : 0);
  wrap.addEventListener("pointermove", (e) => {
    const r = ratioAt(e);
    w.tip.style.left = r * wrap.clientWidth + "px";
    w.tip.textContent = fmtTime(r * dur());
    if (P.seeking) setProgress(r);
  });
  wrap.addEventListener("pointerdown", (e) => {
    if (!curSong()) return;
    P.seeking = true;
    wrap.classList.add("dragging");
    wrap.setPointerCapture(e.pointerId);
    setProgress(ratioAt(e));
  });
  wrap.addEventListener("pointerup", (e) => {
    if (!P.seeking) return;
    P.seeking = false;
    wrap.classList.remove("dragging");
    const d = dur();
    if (d) seekTo(ratioAt(e) * d);
  });
  wrap.addEventListener("pointercancel", () => { P.seeking = false; wrap.classList.remove("dragging"); });
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { seekTo(audio.currentTime - 5); e.preventDefault(); }
    if (e.key === "ArrowRight") { seekTo(audio.currentTime + 5); e.preventDefault(); }
  });
  new ResizeObserver(() => drawWave(w)).observe(wrap);
  waves.push(w);
}
function drawWave(w) {
  const { wrap, base, fill } = w;
  const dpr = devicePixelRatio || 1, cw = wrap.clientWidth, ch = wrap.clientHeight;
  if (!cw || !ch) return;
  for (const c of [base, fill]) { c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr); }
  const step = w.bar + w.gap, bars = Math.max(10, Math.floor(cw / step));
  if (!w.shape || w.shape.seed !== waveSeed || w.shape.n !== bars) w.shape = { seed: waveSeed, n: bars, v: waveShape(waveSeed || "idle", bars) };
  const idle = !waveSeed;
  const paint = (c, color) => {
    const g = c.getContext("2d");
    g.scale(dpr, dpr);
    g.fillStyle = color;
    for (let i = 0; i < bars; i++) {
      const bh = Math.max(3, (idle ? 0.14 : w.shape.v[i]) * ch);
      g.beginPath();
      g.roundRect(i * step + 0.5, (ch - bh) / 2, w.bar, bh, w.bar / 2);
      g.fill();
    }
  };
  paint(base, "rgba(255,255,255,0.2)");
  paint(fill, accentNow);
}
function drawWaves() { for (const w of waves) drawWave(w); }
function setProgress(r) {
  const v = `inset(0 ${(100 - clamp(r, 0, 1) * 100).toFixed(2)}% 0 0)`;
  for (const w of waves) w.fill.style.clipPath = v;
}

/* ---------- Transport ---------- */
function seekTo(sec) {
  const d = audio.duration || (curSong() ? curSong().duration : 0);
  audio.currentTime = clamp(sec, 0, d || 0);
  tick();
}
function shuffled(ids, firstId) {
  const a = ids.filter((x) => x !== firstId);
  for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; }
  return firstId ? [firstId, ...a] : a;
}
/** Starts playing `songs`, beginning at index `start`. */
function playList(songs, start = 0, opts = {}) {
  if (!songs.length) return;
  const ids = songs.map((s) => s.id);
  P.base = ids.slice();
  if (opts.shuffle != null) setShuffle(opts.shuffle, true);
  if (store.shuffle) {
    const first = opts.shuffle ? ids[(Math.random() * ids.length) | 0] : ids[start];
    P.list = shuffled(ids, first);
    P.i = 0;
  } else {
    P.list = ids.slice();
    P.i = start;
  }
  P.errors = 0;
  loadCurrent(true);
  renderQueue();
}
function playSong(song, context) {
  const list = context && context.length ? context : [song];
  playList(list, Math.max(0, list.indexOf(song)));
}
function loadCurrent(autoplay, startAt) {
  const s = curSong();
  if (!s) return;
  P.counted = false;
  audio.src = srcOf(s);
  if (startAt) audio.addEventListener("loadedmetadata", () => { audio.currentTime = Math.min(startAt, audio.duration || startAt); }, { once: true });
  if (autoplay) audio.play().catch(() => {});
  waveSeed = s.id;
  for (const w of waves) w.shape = null;
  setAccent(s.color);
  renderNowPlaying();
  setProgress(0);
  $$(".t-cur").forEach((e) => (e.textContent = "0:00"));
  $$(".t-dur").forEach((e) => (e.textContent = fmtTime(s.duration)));
  store.last = { id: s.id, pos: startAt || 0 };
  saveStore();
  updateMediaSession(s);
  refreshPlaying();
  if (typeof onSongChanged === "function") onSongChanged();
}
function togglePlay() {
  if (!curSong()) {
    if (lib.sorted.length) playList(lib.sorted, 0, { shuffle: true });
    return;
  }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}
function next(auto) {
  if (!P.list.length) return;
  if (auto && store.repeat === 2) { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  if (P.i + 1 < P.list.length) P.i++;
  else if (store.repeat === 1 || !auto) P.i = 0;
  else { audio.pause(); seekTo(0); return; }
  loadCurrent(true);
  followQueue();
}
function prev() {
  if (!P.list.length) return;
  if (audio.currentTime > 3 || (P.i === 0 && store.repeat !== 1)) { seekTo(0); return; }
  P.i = P.i === 0 ? P.list.length - 1 : P.i - 1;
  loadCurrent(true);
  followQueue();
}
function jumpTo(i) { P.i = clamp(i, 0, P.list.length - 1); loadCurrent(true); followQueue(); }
function setShuffle(on, silent) {
  store.shuffle = !!on;
  const cur = curSong();
  if (!silent && P.list.length) {
    if (on) { P.list = shuffled(P.list, cur && cur.id); P.i = cur ? 0 : -1; }
    else {
      const id = cur && cur.id;
      P.list = P.base.slice();
      if (id && !P.list.includes(id)) P.list.unshift(id);
      P.i = id ? P.list.indexOf(id) : -1;
    }
    renderQueue();
    renderUpNext();
  }
  renderToggles();
  saveStore();
}
function cycleRepeat() {
  store.repeat = (store.repeat + 1) % 3;
  renderToggles();
  saveStore();
  toast(["Repeat off", "Repeat all", "Repeat this song"][store.repeat]);
}
function enqueue(songs, where) {
  if (!songs.length) return;
  const ids = songs.map((s) => s.id);
  if (!P.list.length) { playList(songs, 0); return; }
  if (where === "next") {
    P.list.splice(P.i + 1, 0, ...ids);
    const bi = P.base.indexOf(P.list[P.i]);
    P.base.splice(bi + 1, 0, ...ids);
  } else { P.list.push(...ids); P.base.push(...ids); }
  renderQueue();
  renderUpNext();
  toast(where === "next" ? `Playing next: ${songs.length > 1 ? plural(songs.length, "song") : songs[0].title}` : `Added to queue`);
}
function removeFromQueue(i) {
  if (i === P.i) return;
  P.list.splice(i, 1);
  if (i < P.i) P.i--;
  renderQueue();
  renderUpNext();
}
function clearQueue() {
  const cur = curSong();
  P.list = cur ? [cur.id] : [];
  P.base = P.list.slice();
  P.i = cur ? 0 : -1;
  renderQueue();
  renderUpNext();
}
function setVolume(v) {
  v = clamp(v, 0, 1);
  audio.volume = v;
  store.vol = v;
  $$(".js-vol").forEach((r) => { r.value = v; r.style.setProperty("--p", v * 100 + "%"); });
  const name = v === 0 ? "mute" : v < 0.4 ? "vol-low" : "vol";
  $$(".js-mute use").forEach((u) => u.setAttribute("href", "#i-" + name));
  saveStore();
}
function toggleMute() {
  if (audio.volume > 0) { preMute = audio.volume; setVolume(0); } else setVolume(preMute || 0.8);
}

/* ---------- Likes ---------- */
const isLiked = (id) => likeSet.has(id);
function toggleLike(id) {
  if (likeSet.has(id)) { likeSet.delete(id); store.likes = store.likes.filter((x) => x !== id); }
  else { likeSet.add(id); store.likes.unshift(id); toast("Added to Liked songs"); }
  saveStore();
  renderLikeButton();
  if (typeof onLikesChanged === "function") onLikesChanged();
}

/* ---------- Rendering ---------- */
function paintCover(host, s) {
  if (!host.firstChild) host.prepend(...coverEl("").childNodes);
  const ph = host.querySelector(".ph"), img = host.querySelector("img");
  const url = s && coverUrl(s.cover);
  if (url) { if (img.getAttribute("src") !== url) img.src = url; img.hidden = false; ph.hidden = true; }
  else {
    img.hidden = true; ph.hidden = false;
    ph.style.background = s ? `linear-gradient(135deg, hsl(${hash(s.album) % 360} 42% 30%), hsl(${(hash(s.album) + 48) % 360} 46% 20%))` : "";
  }
}
function renderNowPlaying() {
  const s = curSong();
  const cv = $("#np-cover");
  if (!cv.querySelector(".ph")) { const t = coverEl(""); cv.prepend(...t.childNodes); }
  paintCover(cv, s);
  paintCover($("#npv-cover"), s);
  const artist = s ? artistLabel(s.artist) : "";
  $("#np-title").textContent = s ? s.title : "Nothing playing";
  $("#np-artist").textContent = s ? artist : lib.songs.length ? "Pick a song to start" : "Add some music to begin";
  $("#npv-title").textContent = s ? s.title : "Nothing playing";
  $("#npv-artist").textContent = artist;
  $("#npv-album").textContent = s ? [s.album, s.year || ""].filter(Boolean).join(" · ") : "";
  renderLikeButton();
  renderUpNext();
}
function renderLikeButton() {
  const s = curSong();
  const on = !!s && likeSet.has(s.id);
  $$(".js-like").forEach((b) => {
    b.classList.toggle("on", on);
    b.innerHTML = icon(on ? "heart-fill" : "heart");
    b.style.visibility = s ? "visible" : "hidden";
  });
}
function renderPlayState() {
  const playing = isPlaying();
  $$(".js-play").forEach((b) => {
    b.classList.toggle("is-play", !playing);
    b.innerHTML = icon(playing ? "pause" : "play");
    b.setAttribute("aria-label", playing ? "Pause" : "Play");
  });
  document.body.classList.toggle("is-paused", !playing);
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
}
function renderToggles() {
  $$(".js-shuffle").forEach((b) => b.classList.toggle("on", store.shuffle));
  $$(".js-repeat").forEach((r) => {
    r.classList.toggle("on", store.repeat > 0);
    r.innerHTML = icon(store.repeat === 2 ? "repeat1" : "repeat");
  });
  $("#b-queue").classList.toggle("on", !$("#queue-panel").hidden);
}
function refreshPlaying() {
  if (typeof rebindViews === "function") rebindViews();
  if (qList) qList.rebind();
}
function renderUpNext() {
  const box = $("#npv-next");
  if (!box || $("#nowplaying").hidden) return;
  const up = P.list.slice(P.i + 1, P.i + 5).map((id) => lib.byId.get(id)).filter(Boolean);
  box.innerHTML = up.length ? `<div class="n-head">Up next</div>` : "";
  up.forEach((s, k) => {
    const row = el("button", "n-item", `<div class="n-cv"></div><div style="min-width:0"><div class="n-t"></div><div class="n-a"></div></div>`);
    const c = coverEl(""); row.firstChild.replaceWith(c);
    setCover(c, s.cover, s.album);
    row.querySelector(".n-t").textContent = s.title;
    row.querySelector(".n-a").textContent = artistLabel(s.artist);
    row.onclick = () => jumpTo(P.i + 1 + k);
    box.appendChild(row);
  });
}

/* ---------- Full screen Now Playing ---------- */
function openNowPlaying() {
  if (!curSong()) return;
  const np = $("#nowplaying");
  np.hidden = false;
  renderUpNext();
  requestAnimationFrame(() => { np.classList.add("open"); drawWaves(); });
  $("#npv-close").focus({ preventScroll: true });
}
function closeNowPlaying() {
  const np = $("#nowplaying");
  if (np.hidden) return;
  np.classList.remove("open");
  setTimeout(() => { if (!np.classList.contains("open")) np.hidden = true; }, 320);
}

/* ---------- Queue panel ---------- */
let qList = null;
function renderQueue() {
  const panel = $("#queue-panel");
  if (panel.hidden) return;
  const scroller = $("#q-list");
  if (qList) qList.destroy();
  scroller.innerHTML = "";
  const host = el("div");
  scroller.appendChild(host);
  if (!P.list.length) {
    host.innerHTML = `<div class="empty inline"><p>Your queue is empty.<br>Play a song or choose “Add to queue”.</p></div>`;
    qList = null;
    return;
  }
  qList = VList({
    scroller, host, count: P.list.length, h: 54,
    create() {
      const r = el("div", "row cols q-cols");
      r.innerHTML = `<div class="cover s40"></div><div class="t-text"><div class="t-title"></div><div class="t-sub"></div></div><button class="icon-btn small more" aria-label="Remove from queue">${icon("close")}</button>`;
      const c = coverEl("s40"); r.replaceChild(c, r.firstChild);
      return r;
    },
    bind(r, i) {
      const s = lib.byId.get(P.list[i]);
      if (!s) { r.hidden = true; return; }
      r.classList.toggle("playing", i === P.i);
      setCover(r.firstChild, s.cover, s.album);
      r.querySelector(".t-title").textContent = s.title;
      r.querySelector(".t-sub").textContent = artistLabel(s.artist);
    },
  });
  scroller.onclick = (e) => {
    const r = e.target.closest(".row");
    if (!r) return;
    if (e.target.closest(".more")) removeFromQueue(r._i); else jumpTo(r._i);
  };
  scroller.scrollTop = Math.max(0, P.i * 54 - 54);
}
function followQueue() {
  const panel = $("#queue-panel");
  if (panel.hidden) return;
  const sc = $("#q-list");
  const y = P.i * 54;
  if (y < sc.scrollTop || y > sc.scrollTop + sc.clientHeight - 108) sc.scrollTop = Math.max(0, y - 54);
}
function toggleQueue(force) {
  const panel = $("#queue-panel");
  panel.hidden = force != null ? !force : !panel.hidden;
  renderToggles();
  if (!panel.hidden) renderQueue();
}

/* ---------- Media keys and system overlay ---------- */
function updateMediaSession(s) {
  if (!("mediaSession" in navigator)) return;
  const art = coverUrl(s.cover);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: s.title, artist: artistLabel(s.artist), album: s.album,
    artwork: art ? [{ src: art, sizes: "320x320", type: "image/jpeg" }] : [],
  });
}
function initMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (_) {} };
  set("play", () => audio.play().catch(() => {}));
  set("pause", () => audio.pause());
  set("previoustrack", prev);
  set("nexttrack", () => next(false));
  set("seekto", (d) => seekTo(d.seekTime));
}

/* ---------- Progress ticking (only while playing and visible) ---------- */
let tickTimer = 0, lastSec = -1;
function tick() {
  const s = curSong();
  if (!s) return;
  const c = audio.currentTime, d = audio.duration || s.duration || 0;
  if (!P.counted && c >= Math.min(30, d / 2)) {
    P.counted = true;
    store.plays[s.id] = (store.plays[s.id] || 0) + 1;
    store.recent = [s.id, ...store.recent.filter((x) => x !== s.id)].slice(0, 60);
    saveStore();
  }
  const now = Date.now();
  if (now - P.lastSave > 5000) { P.lastSave = now; store.last = { id: s.id, pos: c }; saveStore(); }
  if (document.hidden) return;
  if (!P.seeking) setProgress(d ? c / d : 0);
  const sec = Math.floor(c);
  if (sec !== lastSec) { lastSec = sec; const t = fmtTime(c); $$(".t-cur").forEach((e) => (e.textContent = t)); }
}
audio.addEventListener("play", () => { renderPlayState(); clearInterval(tickTimer); tickTimer = setInterval(tick, 120); refreshPlaying(); });
audio.addEventListener("pause", () => { renderPlayState(); clearInterval(tickTimer); tick(); refreshPlaying(); });
audio.addEventListener("ended", () => next(true));
audio.addEventListener("loadedmetadata", () => { if (isFinite(audio.duration)) { const t = fmtTime(audio.duration); $$(".t-dur").forEach((e) => (e.textContent = t)); } });
audio.addEventListener("seeked", tick);
audio.addEventListener("error", () => {
  const s = curSong();
  if (!s) return;
  toast(`Can't play “${s.title}”. The file may have moved.`);
  if (++P.errors < 5) setTimeout(() => next(true), 700);
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) { lastSec = -1; tick(); } });

function initPlayer() {
  likeSet = new Set(store.likes);
  $$("[data-wave]").forEach(createWave);
  initMediaSession();
  $$(".js-play").forEach((b) => (b.onclick = togglePlay));
  $$(".js-next").forEach((b) => (b.onclick = () => next(false)));
  $$(".js-prev").forEach((b) => (b.onclick = prev));
  $$(".js-shuffle").forEach((b) => (b.onclick = () => setShuffle(!store.shuffle)));
  $$(".js-repeat").forEach((b) => (b.onclick = cycleRepeat));
  $$(".js-like").forEach((b) => (b.onclick = () => { const s = curSong(); if (s) toggleLike(s.id); }));
  $$(".js-mute").forEach((b) => (b.onclick = toggleMute));
  $$(".js-vol").forEach((r) => (r.oninput = (e) => setVolume(+e.target.value)));
  $("#b-queue").onclick = () => toggleQueue();
  $("#q-close").onclick = () => toggleQueue(false);
  $("#q-clear").onclick = clearQueue;
  $("#np-cover").onclick = openNowPlaying;
  $("#npv-close").onclick = closeNowPlaying;
  const toArtist = () => { const s = curSong(); if (!s) return; closeNowPlaying(); openArtist(lib.artists.find((a) => a.name === s._pa)?.id); };
  $("#np-title").onclick = () => { const s = curSong(); if (s) { closeNowPlaying(); openAlbum(s._album.id); } };
  $("#np-artist").onclick = toArtist;
  $("#npv-artist").onclick = toArtist;
  setVolume(store.vol);
  renderPlayState();
  renderToggles();
  renderNowPlaying();
  drawWaves();
}

/** Restores the last song (paused) so the app opens where you left off. */
function restoreLast() {
  const l = store.last;
  if (!l || !lib.byId.has(l.id) || P.list.length) return;
  const ids = lib.sorted.map((s) => s.id);
  P.base = ids.slice();
  if (store.shuffle) { P.list = shuffled(ids, l.id); P.i = 0; } else { P.list = ids; P.i = ids.indexOf(l.id); }
  loadCurrent(false, l.pos);
}
