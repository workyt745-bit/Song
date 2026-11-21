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
    <div class="np2-type" aria-hidden="true"></div>
    <div class="np2-fade"></div>
    ${store.deck !== false ? `    <div class="np2-deck" aria-hidden="true">
      <div class="deck-disc"><div class="deck-label"><i></i></div></div>
      <svg class="deck-arm" viewBox="0 0 100 130"><g fill="none" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="80" cy="16" r="11" fill="#2a2c33" stroke="#43454e" stroke-width="2"/>
        <circle cx="80" cy="16" r="4" fill="#9a9ca6" stroke="none"/>
        <path d="M80 16 L80 24 L34 96" stroke="#b9bbc4" stroke-width="4.5"/>
        <path d="M34 96 L28 108" stroke="#8b8d97" stroke-width="9"/>
        <path d="M26 112 L24 116" stroke="#d9d9de" stroke-width="3"/></g></svg>
    </div>` : ""}
    <div class="np2-stage">
      <div class="np2-ring"><canvas></canvas><div class="np2-cover"></div></div>
      <h1 class="np2-title"></h1>
      <div class="np2-artist"></div>
      <div class="np2-album"></div>
    </div>`;
  sc.appendChild(root);
  const q = (x) => root.querySelector(x);

  // Giant artist name in the background: rows slide slowly in opposite directions (only while music plays).
  const typeBox = q(".np2-type");
  const buildType = () => {
    if (!typeBox.isConnected) return;
    const unitText = artistLabel(s.artist).toUpperCase() + " \u00b7 ";
    typeBox.innerHTML = '<div class="np2-row" style="position:absolute;visibility:hidden;animation:none"><span></span></div>';
    const probe = typeBox.firstChild; probe.firstChild.textContent = unitText;
    const unit = Math.max(40, probe.firstChild.offsetWidth);
    const n = Math.max(1, Math.ceil((root.clientWidth * 1.3) / unit));
    const half = unitText.repeat(n);
    let h = "";
    for (let i = 0; i < 5; i++) h += '<div class="np2-row r' + i + '"><span>' + half + "</span><span>" + half + "</span></div>";
    typeBox.innerHTML = h;
  };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(buildType); else buildType();
  let typeW = 0;
  const typeRO = new ResizeObserver(() => { const w = root.clientWidth; if (Math.abs(w - typeW) > 80) { typeW = w; buildType(); } });
  typeRO.observe(root);
  q(".np2-title").textContent = s.title;
  q(".np2-artist").textContent = artistLabel(s.artist);
  q(".np2-album").textContent = s.album && s.album !== "Unknown Album" ? s.album : "";

  const cv = coverEl("");
  q(".np2-cover").appendChild(cv);
  setCover(cv, s.cover, s.album || s.title);


  // The background: a calm gradient made from the cover's own colors, and a record that turns slowly
  // behind the cover. Nothing here is redrawn every frame, so it costs almost nothing.
  const pickTones = () => {
    const img = cv.querySelector("img");
    if (!img || !img.naturalWidth) return;
    try {
      const t = document.createElement("canvas"); t.width = t.height = 20;
      const x = t.getContext("2d", { willReadFrequently: true });
      x.drawImage(img, 0, 0, 20, 20);
      const d = x.getImageData(0, 0, 20, 20).data;
      const bins = Array.from({ length: 6 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx < 40) continue;
        const sat = (mx - mn) / mx, w = sat * sat * (mx / 255) + 0.02;
        let h = 0;
        if (mx !== mn) { const dd = mx - mn; h = mx === r ? ((g - b) / dd + 6) % 6 : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4; }
        const bin = bins[Math.min(5, Math.floor(h))];
        bin.w += w; bin.r += r * w; bin.g += g * w; bin.b += b * w;
      }
      const top = bins.filter((b) => b.w > 0).sort((a, b) => b.w - a.w).slice(0, 3)
        .map((b) => [Math.round(b.r / b.w), Math.round(b.g / b.w), Math.round(b.b / b.w)]);
      if (!top.length) return;
      while (top.length < 3) top.push(top[top.length - 1]);
      const c = (k, a) => "rgba(" + top[k].join(",") + "," + a + ")";
      q(".np2-bg").style.background =
        "radial-gradient(80% 90% at 14% 14%," + c(0, 0.34) + ", transparent 75%)," +
        "radial-gradient(75% 85% at 92% 72%," + c(1, 0.28) + ", transparent 75%)," +
        "radial-gradient(60% 60% at 50% 46%," + c(2, 0.16) + ", transparent 80%)," +
        "var(--surface)";
    } catch (e) { /* the picture can't be read: the accent gradient stays */ }
  };
  const ci = cv.querySelector("img");
  if (ci) { if (ci.complete) pickTones(); ci.addEventListener("load", pickTones); }
  const onPlay = () => root.classList.add("spin");
  audio.addEventListener("play", onPlay);
  if (!audio.paused) root.classList.add("spin");

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
  const onPause = () => { root.classList.remove("spin"); settle(); };
  audio.addEventListener("pause", onPause);
  fit();
  new ResizeObserver(() => { fit(); draw(); }).observe(q(".np2-ring"));
  playingView = { feed };
  if (audio.paused) { for (let k = 0; k < HALF; k++) lv[k] = 0.06 + 0.04 * Math.sin(k * 0.7); draw(); }
  cur.cleanups.push(() => { dead = true; typeRO.disconnect(); cancelAnimationFrame(idle); audio.removeEventListener("pause", onPause); audio.removeEventListener("play", onPlay); playingView = null; });
}
