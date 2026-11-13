/* Now playing: photos of the artist that change slowly, plus their biography.
   The app downloads photos once per artist and keeps them on disk; this file only shows them.
   Only two photos are ever loaded in memory at a time, so it stays light. */
"use strict";

const artistReq = new Map(); // artist name -> { promise, failedAt }

function loadArtist(name) {
  if (store.photos === false) return Promise.resolve({ error: "off" });
  if (!IS_APP && !lib.isDemo) return Promise.resolve({ error: "browser" });
  const hit = artistReq.get(name);
  if (hit && (!hit.failedAt || Date.now() - hit.failedAt < 60000)) return hit.promise;
  const entry = {};
  entry.promise = (async () => {
    try {
      return await invoke("artist_info", { name });
    } catch (e) {
      entry.failedAt = Date.now();
      return { error: /offline/i.test(String(e)) ? "offline" : "other", detail: String(e) };
    }
  })();
  artistReq.set(name, entry);
  return entry.promise;
}

let playingView = null;
function onSongChanged() {
  if (typeof prefetchLyrics === "function") prefetchLyrics();
  if (route.t === "lyrics") return render(false);
  if (route.t !== "playing") return;
  const s = curSong();
  if (playingView && s && playingView.artist === s._pa) playingView.setSong(s);
  else render(false);
}

const songLine = (s) => s.title + (s.album && s.album !== "Unknown Album" && s.album !== s.title ? " · " + s.album : "");

function viewPlaying(sc) {
  sc.classList.add("stage");
  const s = curSong();
  if (!s) {
    const d = emptyState("note", "Nothing is playing", "Play a song and photos of the artist will appear here, along with their story.", null, null, true);
    const row = el("div", "btn-row");
    const b = el("button", "btn primary", icon("shuffle") + "Shuffle my music");
    b.onclick = () => playList(lib.sorted, 0, { shuffle: true });
    row.appendChild(b);
    d.appendChild(row);
    sc.appendChild(d);
    return;
  }

  const artist = s._pa;
  const root = el("div", "stage-root");
  root.innerHTML = `
    <div class="stage-fallback"></div>
    <div class="stage-bg"><img class="ph" alt="" decoding="async"><img class="ph" alt="" decoding="async"></div>
    <div class="stage-shade"></div>
    <div class="st-cover" hidden></div>
    <div class="stage-info">
      <h1 class="st-artist"></h1>
      <div class="st-song"></div>
      <div class="st-body"></div>
      <div class="st-foot"><div class="st-dots"></div><span class="st-credit"></span></div>
    </div>`;
  sc.appendChild(root);
  const q = (sel) => root.querySelector(sel);
  q(".st-artist").textContent = artist;
  const setSong = (song) => { q(".st-song").textContent = songLine(song); };
  setSong(s);

  let timer = 0, dead = false;
  playingView = { artist, setSong };
  cur.cleanups.push(() => { dead = true; clearInterval(timer); playingView = null; });

  const body = q(".st-body");
  const note = (text, btn) => {
    body.innerHTML = "";
    body.appendChild(el("p", "st-note", esc(text)));
    if (btn) { const b = el("button", "btn", esc(btn.label)); b.onclick = btn.run; body.appendChild(b); }
  };
  const showCover = () => {
    const c = q(".st-cover");
    c.hidden = false;
    if (!c.firstChild) { const cv = coverEl(""); c.appendChild(cv); setCover(cv, s.cover, s.album); }
  };

  if (artist === "Unknown Artist") {
    showCover();
    return note("This song has no artist name saved in its tags, so there are no photos to show.");
  }

  body.innerHTML = `<p class="st-note">Finding photos of ${esc(artist)}…</p><div class="st-load"><i></i></div>`;
  loadArtist(artist).then((r) => {
    if (dead) return;
    if (r.error === "off") {
      showCover();
      return note("Artist photos are turned off.", { label: "Turn on", run: () => { store.photos = true; saveStore(); render(false); } });
    }
    if (r.error === "browser") { showCover(); return note("Artist photos work in the Pulse desktop app."); }
    if (r.error) {
      showCover();
      return note(r.error === "offline" ? "Can’t reach the internet right now. Pulse will try again the next time you open this tab." : "Couldn’t get photos for this artist.", { label: "Try again", run: () => { artistReq.delete(artist); render(false); } });
    }
    const urls = (r.images || []).map((p) => (p.startsWith("data:") ? p : fileUrl(p)));
    if (!urls.length && !r.bio) { showCover(); return note(`No photos found for ${artist}.`); }

    // Biography, clamped, with a Read more button only when it is long.
    body.innerHTML = "";
    if (r.bio) {
      const p = el("p", "st-bio");
      p.textContent = r.bio;
      body.appendChild(p);
      requestAnimationFrame(() => {
        if (p.scrollHeight > p.clientHeight + 2) {
          const more = el("button", "st-more", "Read more");
          more.onclick = () => { const open = p.classList.toggle("open"); more.textContent = open ? "Show less" : "Read more"; };
          body.appendChild(more);
        }
      });
    }
    q(".st-credit").textContent = r.credit ? `From ${r.credit}` : "";
    if (!urls.length) { showCover(); return; }
    startShow(urls);
  });

  function startShow(urls) {
    const [A, B] = root.querySelectorAll(".stage-bg .ph");
    const dots = q(".st-dots");
    let front = null, idx = 0;
    const paintDots = () => {
      dots.innerHTML = "";
      if (urls.length < 2) return;
      urls.forEach((_, i) => {
        const b = el("button", i === idx ? "on" : "");
        b.setAttribute("aria-label", "Photo " + (i + 1));
        b.onclick = () => { show(i); restart(); };
        dots.appendChild(b);
      });
    };
    const show = (i) => {
      if (dead || !urls.length) return;
      idx = (i + urls.length) % urls.length;
      const incoming = front === A ? B : A;
      incoming.onload = () => {
        incoming.onload = null;
        if (dead) return;
        const old = front;
        if (old) { old.classList.replace("on", "out"); setTimeout(() => old.classList.remove("out"), 1800); }
        incoming.classList.remove("out");
        incoming.classList.add("on");
        front = incoming;
        paintDots();
      };
      incoming.onerror = () => {
        incoming.onerror = null;
        urls.splice(idx, 1);
        if (!urls.length) { showCover(); return; }
        show(idx);
      };
      incoming.src = urls[idx];
    };
    const restart = () => {
      clearInterval(timer);
      timer = setInterval(() => { if (!document.hidden && !audio.paused && urls.length > 1) show(idx + 1); }, 9000);
    };
    show(0);
    restart();
  }
}
