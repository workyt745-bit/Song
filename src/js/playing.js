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
    <canvas class="np2-fx"></canvas>
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

  const cv = coverEl("");
  q(".np2-cover").appendChild(cv);
  setCover(cv, s.cover, s.album || s.title);


  // The background: glowing sparks float up (faster when the music is loud), and a soft shockwave
  // leaves the cover on every strong beat. It is drawn small and stretched, so it costs almost nothing.
  const fxc = q(".np2-fx"), fg = fxc.getContext("2d");
  const SP = 46, sp = [];
  let rt = 0, fw = 0, fh = 0, waves = [], prevBeat = 0, lastT = performance.now(), cool = 0;
  const mkSpark = (anywhere) => ({
    x: Math.random() * fw, y: anywhere ? Math.random() * fh : fh + 10,
    v: 14 + Math.random() * 34, r: 0.8 + Math.random() * 2.2, ph: Math.random() * 6.28, sw: 8 + Math.random() * 18, tw: 0.6 + Math.random() * 1.6,
  });
  const fitFx = () => {
    const S = 0.5;
    fw = Math.max(1, Math.round(root.clientWidth * S)); fh = Math.max(1, Math.round(root.clientHeight * S));
    fxc.width = fw; fxc.height = fh;
    if (!sp.length) for (let i = 0; i < SP; i++) sp.push(mkSpark(true));
  };
  const drawFx = (energy, beat) => {
    if (dead || !fw) return;
    const now = performance.now(), dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
    const col = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#a99cff";
    fg.clearRect(0, 0, fw, fh);
    // Light ribbons: three glowing threads flow across the screen behind the cover.
    // Bass swells them in the middle, treble ripples them at the edges.
    rt += dt * (0.5 + energy * 1.6);
    const N = 36, cyR = fh * 0.44;
    fg.globalCompositeOperation = "lighter";
    fg.lineJoin = "round";
    for (let r = 0; r < 3; r++) {
      const ph = rt * (0.8 + r * 0.35) + r * 2.1, f = 2.2 + r * 0.9;
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N, d = Math.abs(t - 0.5) * 2;
        const v = lv[Math.min(HALF - 1, Math.floor(d * (HALF - 1) * 0.9))];
        const amp = fh * (0.03 + 0.2 * v) * Math.sin(Math.PI * t);
        const y = cyR + (r - 1) * fh * 0.07 + Math.sin(t * f * 6.283 + ph) * amp + Math.sin(t * 9 + ph * 1.7) * amp * 0.25 * v;
        pts.push(t * fw, y);
      }
      for (let pass = 0; pass < 2; pass++) {
        fg.beginPath(); fg.moveTo(pts[0], pts[1]);
        for (let i = 2; i < pts.length; i += 2) {
          const mx = (pts[i - 2] + pts[i]) / 2, my = (pts[i - 1] + pts[i + 1]) / 2;
          fg.quadraticCurveTo(pts[i - 2], pts[i - 1], mx, my);
        }
        fg.strokeStyle = r === 1 ? "#ffffff" : col;
        fg.lineWidth = pass ? Math.max(1, fw * 0.0016) : Math.max(4, fw * 0.011);
        fg.globalAlpha = (pass ? 0.5 : 0.07) * (0.55 + energy * 1.3) * (r === 1 ? 0.7 : 1);
        fg.stroke();
      }
    }
    fg.globalCompositeOperation = "source-over";
    cool -= dt;
    if (beat > 0.3 && beat - prevBeat > 0.1 && cool <= 0) { waves.push({ r: fw * 0.1, a: 0.5 }); cool = 0.28; if (waves.length > 4) waves.shift(); }
    prevBeat = beat;
    const cx = fw / 2, cy = fh * 0.44;
    fg.strokeStyle = col; fg.fillStyle = col;
    fg.lineWidth = Math.max(1.5, fw * 0.004);
    for (let i = waves.length - 1; i >= 0; i--) {
      const w = waves[i];
      w.r += dt * fw * 0.55; w.a -= dt * 0.55;
      if (w.a <= 0) { waves.splice(i, 1); continue; }
      fg.globalAlpha = w.a; fg.beginPath(); fg.arc(cx, cy, w.r, 0, 6.2832); fg.stroke();
    }
    const boost = 1 + energy * 3.2;
    for (const p of sp) {
      p.y -= p.v * boost * dt * 0.5; p.ph += dt * p.tw;
      if (p.y < -8) Object.assign(p, mkSpark(false));
      const x = p.x + Math.sin(p.ph) * p.sw * 0.5;
      const edge = Math.min(1, p.y / (fh * 0.25), (fh - p.y) / (fh * 0.15) + 0.2);
      fg.globalAlpha = Math.max(0, edge) * (0.18 + 0.32 * (0.5 + 0.5 * Math.sin(p.ph * 2.3))) * (0.6 + energy * 1.1);
      fg.beginPath(); fg.arc(x, p.y, p.r * (1 + energy * 0.9), 0, 6.2832); fg.fill();
    }
    fg.globalAlpha = 1;
  };

  // The ring: bars around the cover. They are mirrored left and right, so it looks balanced.
  const canvas = q(".np2-ring canvas"), g = canvas.getContext("2d");
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
    let e = 0; for (let k = 0; k < 8; k++) e += lv[k];
    drawFx(Math.min(1, e / 8), beat);
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
      drawFx(top * 0.5, 0);
      if (top > 0.005 || waves.length) idle = requestAnimationFrame(step);
    };
    idle = requestAnimationFrame(step);
  };
  const onPause = () => settle();
  audio.addEventListener("pause", onPause);
  fit(); fitFx();
  new ResizeObserver(() => { fit(); draw(); }).observe(q(".np2-ring"));
  new ResizeObserver(fitFx).observe(root);
  playingView = { feed };
  if (audio.paused) { drawFx(0, 0); for (let k = 0; k < HALF; k++) lv[k] = 0.06 + 0.04 * Math.sin(k * 0.7); draw(); }
  cur.cleanups.push(() => { dead = true; cancelAnimationFrame(idle); audio.removeEventListener("pause", onPause); playingView = null; });
}
