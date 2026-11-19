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


  // The background: dim floating sparks, a soft shockwave on strong beats, and a night city
  // far away. The city is drawn once as 3 layers (far, middle, near). The far layer is hazy and
  // the near layer is dark, which is what makes it look deep. The layers slide slowly,
  // and their windows glow a little with the music. It is drawn small, so it costs almost nothing.
  const fxc = q(".np2-fx"), fg = fxc.getContext("2d");
  const SP = 46, sp = [];
  let fw = 0, fh = 0, waves = [], prevBeat = 0, lastT = performance.now(), cool = 0, city = null, offs = [0, 0, 0];
  const mkSpark = (anywhere) => ({
    x: Math.random() * fw, y: anywhere ? Math.random() * fh : fh + 10,
    v: 14 + Math.random() * 34, r: 0.8 + Math.random() * 2.2, ph: Math.random() * 6.28, sw: 8 + Math.random() * 18, tw: 0.6 + Math.random() * 1.6,
  });
  // The same song always gets the same city.
  let seed = 0; for (const ch of String(s.id || s.title)) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) | 0;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const hexRgb = (c) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
    if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
    const r = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(c);
    return r ? [Math.round(+r[1]), Math.round(+r[2]), Math.round(+r[3])] : [169, 156, 255];
  };
  const buildCity = () => {
    const accent = hexRgb(getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
    const ch = Math.round(fh * 0.34), W = Math.round(fw * 1.5);
    // far: hazy and close to the sky color. near: almost black. (haze mixes in a little accent)
    const L = [
      { hMin: 0.2, hMax: 0.5, wMin: 12, wMax: 26, dark: 0.55, haze: 0.2, win: 0.1, cell: 3 },
      { hMin: 0.28, hMax: 0.72, wMin: 16, wMax: 34, dark: 0.78, haze: 0.08, win: 0.2, cell: 4 },
      { hMin: 0.4, hMax: 0.95, wMin: 22, wMax: 46, dark: 0.95, haze: 0, win: 0.3, cell: 5 },
    ];
    city = L.map((p) => {
      const bg = document.createElement("canvas"), wn = document.createElement("canvas");
      bg.width = wn.width = W; bg.height = wn.height = ch;
      const g = bg.getContext("2d"), gw = wn.getContext("2d");
      const mix = (k, v) => Math.round(11 * (1 - p.haze) + accent[k] * p.haze) * (1 - (p.dark - 0.5) * 0.9) + v;
      const front = "rgb(" + [0, 1, 2].map((k) => Math.max(0, Math.round(mix(k, 6)))).join(",") + ")";
      const side = "rgb(" + [0, 1, 2].map((k) => Math.max(0, Math.round(mix(k, 0) * 0.6))).join(",") + ")";
      const roof = "rgb(" + [0, 1, 2].map((k) => Math.min(255, Math.round(mix(k, 22)))).join(",") + ")";
      let x = -4;
      while (x < W) {
        const w = p.wMin + rnd() * (p.wMax - p.wMin), h = ch * (p.hMin + rnd() * (p.hMax - p.hMin)) * 0.98;
        const top = ch - h, d = w * 0.16;
        g.fillStyle = front; g.fillRect(x, top, w, h);
        g.fillStyle = side; g.beginPath(); g.moveTo(x + w, top); g.lineTo(x + w + d, top - d * 0.5); g.lineTo(x + w + d, ch); g.lineTo(x + w, ch); g.fill();
        g.fillStyle = roof; g.beginPath(); g.moveTo(x, top); g.lineTo(x + d, top - d * 0.5); g.lineTo(x + w + d, top - d * 0.5); g.lineTo(x + w, top); g.fill();
        if (rnd() < 0.3) { g.fillStyle = front; g.fillRect(x + w * 0.45, top - h * 0.12, 1.5, h * 0.12); } // little antenna
        // windows: a few are lit, picked at random
        const c = p.cell, cols = Math.floor((w - 3) / c), rows = Math.floor((h - 4) / (c + 2));
        gw.fillStyle = rnd() < 0.5 ? "#ffd9a0" : "rgb(" + accent.join(",") + ")";
        for (let r = 0; r < rows; r++) for (let q2 = 0; q2 < cols; q2++) {
          if (rnd() < p.win) gw.fillRect(x + 2 + q2 * c, top + 3 + r * (c + 2), c - 1.5, c - 0.5);
        }
        x += w + d + rnd() * 5;
      }
      return { bg, wn, W, ch };
    });
  };
  const FXON = store.npfx === true; // the city, sparks and shockwaves are optional (they use graphics power)
  if (!FXON) fxc.style.display = "none";
  const fitFx = () => {
    if (!FXON) return;
    const S = 0.5;
    fw = Math.max(1, Math.round(root.clientWidth * S)); fh = Math.max(1, Math.round(root.clientHeight * S));
    fxc.width = fw; fxc.height = fh;
    if (!sp.length) for (let i = 0; i < SP; i++) sp.push(mkSpark(true));
    seed = 0; for (const ch of String(s.id || s.title)) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) | 0;
    buildCity();
  };
  const SPEED = [3, 6, 11];
  const drawCity = (energy, beat, dt) => {
    if (!city) return;
    for (let i = 0; i < 3; i++) {
      const l = city[i];
      offs[i] = (offs[i] + SPEED[i] * (0.5 + energy * 1.5) * dt) % l.W;
      const y = fh - l.ch + beat * (i + 1) * 1.2;
      fg.globalAlpha = 0.5 + i * 0.25;
      for (let x = -offs[i]; x < fw; x += l.W) fg.drawImage(l.bg, x, y);
      fg.globalAlpha = (0.2 + energy * 0.5) * (0.5 + i * 0.25);
      for (let x = -offs[i]; x < fw; x += l.W) fg.drawImage(l.wn, x, y);
    }
    fg.globalAlpha = 1;
  };
  const drawFx = (energy, beat) => {
    if (dead || !fw) return;
    if (performance.now() - lastT < 40) return; // about 24 pictures a second is enough here
    const now = performance.now(), dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
    const col = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#a99cff";
    fg.clearRect(0, 0, fw, fh);
    drawCity(energy, beat, dt);
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
      fg.globalAlpha = w.a * 0.8; fg.beginPath(); fg.arc(cx, cy, w.r, 0, 6.2832); fg.stroke();
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
    const dpr = 1;
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
