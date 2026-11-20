/* Lyrics: looked up once per song (a few KB), kept on disk by the app, shown here.
   Timed lyrics follow the music and can be clicked to jump. Plain lyrics just scroll. */
"use strict";

const lyricsMem = new Map(); // "artist|title" -> result, so going back and forth costs nothing
const lyKey = (s) => s._pa + "|" + s.title;

function getLyrics(s) {
  if (!IS_APP && !lib.isDemo) return Promise.resolve({ error: "browser" });
  const key = lyKey(s);
  if (lyricsMem.has(key)) return lyricsMem.get(key);
  const online = store.lyrics !== false;
  const p = invoke("lyrics_for", { artist: s._pa, title: s.title, album: s.album, duration: s.duration || 0, path: s.path || "", online })
    .then((r) => r)
    .catch((e) => {
      lyricsMem.delete(key); // errors are never remembered, so the next try starts fresh
      return { error: /offline/i.test(String(e)) ? "offline" : "other" };
    });
  lyricsMem.set(key, p);
  if (lyricsMem.size > 40) lyricsMem.delete(lyricsMem.keys().next().value);
  return p;
}

/** Looks the playing song up in the background, so the Lyrics tab opens instantly. */
let lyTimer = 0;
function prefetchLyrics() {
  clearTimeout(lyTimer);
  const s = curSong();
  if (!s || s._pa === "Unknown Artist" || (!IS_APP && !lib.isDemo)) return;
  lyTimer = setTimeout(() => { if (curSong() === s) getLyrics(s); }, 3500); // skipping around costs nothing
}

function viewLyrics(sc) {
  sc.classList.add("stage");
  const s = curSong();
  if (!s) {
    const d = emptyState("lyrics", "Nothing is playing", "Play a song and its lyrics will appear here.", null, null, true);
    const row = el("div", "btn-row");
    const b = el("button", "btn primary", icon("shuffle") + "Shuffle my music");
    b.onclick = () => playList(lib.sorted, 0, { shuffle: true });
    row.appendChild(b);
    d.appendChild(row);
    sc.appendChild(d);
    return;
  }
  const root = el("div", "ly-root");
  root.innerHTML = `<div class="ly-bg"></div>
    <aside class="ly-side"><div class="ly-cover"></div><div class="ly-title"></div><div class="ly-artist"></div><div class="ly-credit"></div></aside>
    <section class="ly-main"><div class="ly-scroll" tabindex="-1"></div></section>`;
  sc.appendChild(root);
  const q = (x) => root.querySelector(x);
  const cv = coverEl("");
  q(".ly-cover").appendChild(cv);
  setCover(cv, s.cover, s.album);
  q(".ly-title").textContent = s.title;
  q(".ly-artist").textContent = artistLabel(s.artist);
  const box = q(".ly-scroll");

  let dead = false, timer = 0;
  cur.cleanups.push(() => { dead = true; clearInterval(timer); });
  const note = (text, btn) => {
    box.innerHTML = "";
    const w = el("div", "ly-note");
    w.appendChild(el("p", "", esc(text)));
    if (btn) { const b = el("button", "btn", esc(btn.label)); b.onclick = btn.run; w.appendChild(b); }
    box.appendChild(w);
  };

  if (s._pa === "Unknown Artist") return note("This song has no artist name in its tags, so Pulse can’t look its lyrics up.");
  box.innerHTML = `<div class="ly-note"><p>Finding lyrics…</p><div class="st-load"><i></i></div></div>`;

  getLyrics(s).then((r) => {
    if (dead) return;
    if (r.error === "browser") return note("Lyrics work in the Pulse desktop app.");
    if (r.error) return note(r.error === "offline" ? "Can’t reach the internet right now. Pulse will try again the next time you open this tab." : "Couldn’t get lyrics for this song.", { label: "Try again", run: () => { lyricsMem.delete(lyKey(s)); render(false); } });
    if (r.instrumental && !r.synced.length && !r.plain) return note("This one is instrumental, so there are no words.");
    const hasSync = r.synced && r.synced.some((l) => l.text);
    if (!hasSync && !(r.plain || "").trim()) {
      if (store.lyrics === false) return note("Online lyrics are turned off.", { label: "Turn on", run: () => { store.lyrics = true; saveStore(); lyricsMem.delete(lyKey(s)); render(false); } });
      return note(`No lyrics found for “${s.title}”. You can put a .lrc file with the same name next to the song and Pulse will show it.`);
    }
    q(".ly-credit").textContent = r.source ? `Lyrics from ${r.source}` : "";
    box.innerHTML = "";
    if (!hasSync) {
      const p = el("p", "ly-plain");
      p.textContent = r.plain.trim();
      box.appendChild(p);
      return;
    }
    // Timed lyrics: the line being sung is bright and stays in the middle.
    const lines = r.synced;
    const pad = el("div", "ly-pad");
    box.appendChild(pad);
    const nodes = lines.map((l, i) => {
      const p = el("p", "ly-line" + (l.text ? "" : " gap"));
      p.textContent = l.text || "♪";
      p.onclick = () => l.text && seekTo(l.t);
      box.appendChild(p);
      return p;
    });
    box.appendChild(el("div", "ly-pad"));
    let at = -2, lastUser = 0;
    let anim = 0;
    const user = () => { lastUser = Date.now(); cancelAnimationFrame(anim); };
    box.addEventListener("wheel", user, { passive: true });
    box.addEventListener("pointerdown", user);
    box.addEventListener("keydown", user);
    const find = (t) => {
      let lo = 0, hi = lines.length - 1, ans = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (lines[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
      return ans;
    };
    const center = (i, smooth) => {
      const n = nodes[i];
      if (!n) return;
      const to = Math.max(0, n.offsetTop - box.clientHeight / 2 + n.offsetHeight / 2);
      cancelAnimationFrame(anim);
      const from = box.scrollTop, d = to - from;
      if (!smooth || Math.abs(d) < 2) { box.scrollTop = to; return; }
      // One steady glide to the next line (same speed feel every time), instead of the browser's jumpy default.
      const t0 = performance.now(), dur = Math.min(750, 380 + Math.abs(d) * 0.5);
      const step = (t) => {
        const k = Math.min(1, (t - t0) / dur), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        box.scrollTop = from + d * e;
        if (k < 1) anim = requestAnimationFrame(step);
      };
      anim = requestAnimationFrame(step);
    };
    const tick = (first) => {
      const i = find(audio.currentTime + 0.15);
      if (i === at && !first) return;
      if (nodes[at]) nodes[at].classList.remove("now");
      at = i;
      nodes.forEach((n, k) => n.classList.toggle("past", k < i));
      if (nodes[i]) nodes[i].classList.add("now");
      if (first || Date.now() - lastUser > 4000) center(Math.max(i, 0), !first);
    };
    tick(true);
    timer = setInterval(() => { if (!document.hidden) tick(false); }, 120);
    const onSeek = () => tick(false);
    audio.addEventListener("seeked", onSeek);
    cur.cleanups.push(() => { audio.removeEventListener("seeked", onSeek); cancelAnimationFrame(anim); });
  });
}
