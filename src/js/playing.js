/* Now playing: the cover in the middle, with a ring of light that dances to the music.
   Nothing is downloaded. It uses the song's own cover and the sound that is playing. */
"use strict";

let playingView = null;
function onSongChanged() {
  if (typeof prefetchLyrics === "function") prefetchLyrics();
  if (route.t === "lyrics" || route.t === "playing") render(false);
}

function viewPlaying(sc) {
  sc.classList.add("stage");
  const s = curSong();
  if (!s) {
    const d = emptyState("note", "Nothing is playing", "Play a song and its cover comes alive here, moving with the music.", null, null, true);
    const row = el("div", "btn-row");
    const b = el("button", "btn primary", icon("shuffle") + "Shuffle my music");
    b.onclick = () => playList(lib.sorted, 0, { shuffle: true });
    row.appendChild(b);
    d.appendChild(row);
    sc.appendChild(d);
    return;
  }

  const root = el("div", "np2");
  root.innerHTML = `
    <div class="np2-bg"></div>
    <div class="np2-glow"></div>
    <div class="np2-stage">
      <div class="np2-ring"><canvas></canvas><div class="np2-cover"></div></div>
      <h1 class="np2-title"></h1>
      <div class="np2-artist"></div>
      <div class="np2-album"></div>
    </div>`;
  sc.appendChild(root);
  const q = (x) => root.querySelector(x);
  q(".np2-title").textContent = s.title;
  q(".np2-artist").textContent = artistLabel(s.artist);
  q(".np2-album").textContent = s.album && s.album !== "Unknown Album" ? s.album : "";

  // The cover, and a soft blurred copy of it behind everything. The tiny thumbnail stretched wide is already soft, so no heavy blur is needed.
  const cv = coverEl("");
  q(".np2-cover").appendChild(cv);
  setCover(cv, s.cover, s.album || s.title);
  const bgUrl = s.cover ? coverUrl(s.cover, IS_APP) : "";
  if (bgUrl) {
    const im = new Image();
    im.alt = "";
    im.onerror = () => { if (im.src !== coverUrl(s.cover, false)) im.src = coverUrl(s.cover, false); };
    im.src = bgUrl;
    q(".np2-bg").appendChild(im);
  }

  // The ring: bars around the cover. They are mirrored left and right, so it looks balanced.
  const canvas = q("canvas"), g = canvas.getContext("2d");
  const BARS = 64, HALF = BARS / 2;
  const lv = new Float32Array(HALF);
  let size = 0, dead = false, idle = 0;
  const fit = () => {
    const ring = q(".np2-ring");
    size = ring.clientWidth;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = canvas.height = Math.round(size * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const draw = () => {
    if (dead || !size) return;
    g.clearRect(0, 0, size, size);
    const c = size / 2, inner = size * 0.31, maxLen = size * 0.17;
    const col = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#a99cff";
    g.lineCap = "round";
    g.lineWidth = Math.max(3, size * 0.012);
    for (let i = 0; i < BARS; i++) {
      const k = i < HALF ? i : BARS - 1 - i;
      const a = (i / BARS) * Math.PI * 2 - Math.PI / 2;
      const v = lv[k];
      const len = size * 0.012 + v * maxLen;
      const cos = Math.cos(a), sin = Math.sin(a);
      g.strokeStyle = col;
      g.globalAlpha = 0.35 + v * 0.65;
      g.beginPath();
      g.moveTo(c + cos * inner, c + sin * inner);
      g.lineTo(c + cos * (inner + len), c + sin * (inner + len));
      g.stroke();
    }
    g.globalAlpha = 1;
  };
  // Called about 30 times a second with the music's spectrum while it plays.
  const feed = (data, bin, beat) => {
    const lo = 45, hi = 11000;
    for (let k = 0; k < HALF; k++) {
      const f0 = lo * Math.pow(hi / lo, k / HALF), f1 = lo * Math.pow(hi / lo, (k + 1) / HALF);
      const a = Math.max(1, Math.floor(f0 / bin)), z = Math.max(a + 1, Math.ceil(f1 / bin));
      let sum = 0;
      for (let n = a; n < z; n++) sum += data[n];
      // Treble is naturally quieter, so lift it a little to keep the whole ring alive.
      const tilt = 1 + (k / HALF) * 0.9;
      const t = Math.min(1, Math.pow((sum / (z - a) / 255) * tilt, 1.5) * 1.15);
      lv[k] += (t - lv[k]) * (t > lv[k] ? 0.7 : 0.2);
    }
    root.style.setProperty("--beat", beat.toFixed(3));
    draw();
  };
  // When the music is paused or there is no signal, the ring settles down smoothly.
  const settle = () => {
    cancelAnimationFrame(idle);
    const step = () => {
      if (dead) return;
      let top = 0;
      for (let k = 0; k < HALF; k++) { lv[k] *= 0.88; if (lv[k] > top) top = lv[k]; }
      root.style.setProperty("--beat", "0");
      draw();
      if (top > 0.005) idle = requestAnimationFrame(step);
    };
    idle = requestAnimationFrame(step);
  };
  const onPause = () => settle();
  audio.addEventListener("pause", onPause);
  fit();
  new ResizeObserver(() => { fit(); draw(); }).observe(q(".np2-ring"));
  playingView = { feed };
  if (audio.paused) { for (let k = 0; k < HALF; k++) lv[k] = 0.06 + 0.04 * Math.sin(k * 0.7); draw(); }
  cur.cleanups.push(() => { dead = true; cancelAnimationFrame(idle); audio.removeEventListener("pause", onPause); playingView = null; });
}
