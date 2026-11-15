/* Smart lists, listening stats and the duplicate finder. */
"use strict";

const DAY = 864e5;
const dayKey = (t = Date.now()) => { const d = new Date(t); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };

/* ---------- Listening time (called often from tick) ---------- */
let listenWall = 0;
function trackListening() {
  const now = Date.now(), s = curSong();
  const dt = listenWall ? (now - listenWall) / 1000 : 0;
  listenWall = now;
  if (!s || audio.paused || dt <= 0 || dt > 2) return;
  const L = (store.listen = store.listen || { total: 0, days: {}, songs: {} });
  L.total = (L.total || 0) + dt;
  const k = dayKey();
  L.days[k] = (L.days[k] || 0) + dt;
  L.songs[s.id] = (L.songs[s.id] || 0) + dt;
}

/* ---------- Smart lists ---------- */
const SMART = {
  recent: {
    name: "Recently added", hint: "The newest songs in your folders.",
    songs: () => lib.songs.slice().sort((a, b) => b.mtime - a.mtime).slice(0, 50),
  },
  most: {
    name: "Most played", hint: "The songs you play again and again.",
    songs: () => lib.songs.filter((s) => store.plays[s.id] > 0).sort((a, b) => store.plays[b.id] - store.plays[a.id]).slice(0, 50),
  },
  forgotten: {
    name: "Forgotten favorites", hint: "Songs you liked but haven’t played for a month.",
    songs: () => {
      const cut = Date.now() - 30 * DAY, lp = store.lastPlayed || {};
      return likedSongs().filter((s) => (lp[s.id] || 0) < cut).sort((a, b) => (lp[a.id] || 0) - (lp[b.id] || 0));
    },
  },
};

function smartShelf(sc) {
  const box = el("div");
  box.innerHTML = `<div class="shelf-title">Made for you</div>`;
  const row = el("div", "smart-row");
  for (const [id, d] of Object.entries(SMART)) {
    const list = d.songs();
    const b = el("button", "smart-card", `<div class="sm-cover"></div><div class="sm-t"></div><div class="sm-s"></div>`);
    const first = list.find((s) => s.cover);
    const cv = coverEl("");
    setCover(cv, first && first.cover, d.name);
    b.querySelector(".sm-cover").appendChild(cv);
    b.querySelector(".sm-t").textContent = d.name;
    b.querySelector(".sm-s").textContent = list.length ? plural(list.length, "song") : id === "most" ? "Play some songs first" : id === "forgotten" ? "Like songs to fill this" : "Nothing yet";
    b.onclick = () => go({ t: "smart", id });
    row.appendChild(b);
  }
  box.appendChild(row);
  sc.appendChild(box);
}

function viewSmart(sc, id) {
  const d = SMART[id];
  if (!d) return go({ t: "home" }, false);
  const songs = d.songs();
  const total = songs.reduce((t, s) => t + s.duration, 0);
  sc.appendChild(pageHead(d.name, songs.length ? `${plural(songs.length, "song")} · ${fmtTotal(total)}` : d.hint, songs.length ? actionBar(songs) : null));
  if (!songs.length) {
    const msg = id === "most" ? "Songs you play for more than 30 seconds are counted here." : id === "forgotten" ? "Heart some songs and, when you haven’t played one for a month, it comes back here." : "Add a folder to see your newest songs.";
    return sc.appendChild(emptyState("note", "Nothing here yet", msg, null, null, true));
  }
  sc.appendChild(songHeader({}));
  songList(sc, songs, {});
}

/* ---------- Stats ---------- */
function hoursText(sec) {
  if (sec < 60) return Math.round(sec) + " sec";
  if (sec < 3600) return Math.round(sec / 60) + " min";
  return (sec / 3600).toFixed(sec < 36000 ? 1 : 0) + " hours";
}
function viewStats(sc) {
  const L = store.listen || { total: 0, days: {}, songs: {} };
  sc.appendChild(pageHead("Your listening", L.total ? `${hoursText(L.total)} of music so far` : "Pulse counts the time you spend listening, only on this PC."));
  if (!L.total) return sc.appendChild(emptyState("note", "No listening yet", "Play some songs and your top songs, top artists and listening time will show up here.", null, null, true));

  const days = [];
  for (let i = 6; i >= 0; i--) { const t = Date.now() - i * DAY, k = dayKey(t); days.push({ k, sec: L.days[k] || 0, name: new Date(t).toLocaleDateString(undefined, { weekday: "short" }) }); }
  const week = days.reduce((t, d) => t + d.sec, 0), max = Math.max(...days.map((d) => d.sec), 60);

  const topSongs = Object.entries(L.songs).map(([id, sec]) => ({ s: lib.byId.get(id), sec })).filter((x) => x.s).sort((a, b) => b.sec - a.sec);
  const byArtist = new Map();
  for (const { s, sec } of topSongs) for (const n of allArtists(s.artist)) byArtist.set(n, (byArtist.get(n) || 0) + sec);
  const topArtists = [...byArtist.entries()].sort((a, b) => b[1] - a[1]);

  const wrap = el("div", "stats");
  wrap.innerHTML = `
    <div class="st-tiles">
      <div class="st-tile"><b>${esc(hoursText(L.total))}</b><span>all time</span></div>
      <div class="st-tile"><b>${esc(hoursText(week))}</b><span>last 7 days</span></div>
      <div class="st-tile"><b>${plural(Object.keys(store.plays).filter((k) => store.plays[k] > 0 && lib.byId.has(k)).length, "song")}</b><span>played</span></div>
    </div>
    <div class="st-week">${days.map((d) => `<div class="wk"><i style="height:${Math.max(3, (d.sec / max) * 100)}%" title="${esc(hoursText(d.sec))}"></i><span>${esc(d.name)}</span></div>`).join("")}</div>
    <div class="st-cols"><div><h3>Top songs</h3><ol class="top" data-songs></ol></div><div><h3>Top artists</h3><ol class="top" data-artists></ol></div></div>`;
  const fill = (sel, items, label, onclick) => {
    const ol = wrap.querySelector(sel);
    const m = items.length ? items[0].sec : 1;
    items.slice(0, 10).forEach((it, i) => {
      const li = el("li", "", `<button><span class="n">${i + 1}</span><span class="nm"></span><span class="bar"><i style="width:${Math.max(4, (it.sec / m) * 100)}%"></i></span><span class="tm">${esc(hoursText(it.sec))}</span></button>`);
      li.querySelector(".nm").textContent = label(it);
      li.querySelector("button").onclick = () => onclick(it);
      ol.appendChild(li);
    });
  };
  fill("[data-songs]", topSongs, (x) => x.s.title + " · " + x.s._pa, (x) => playList([x.s], 0, { shuffle: false }));
  fill("[data-artists]", topArtists.map(([n, sec]) => ({ n, sec })), (x) => x.n, (x) => { const a = lib.artistById.get("ar" + hash(x.n).toString(36)); if (a) openArtist(a.id); });
  sc.appendChild(wrap);
  sc.appendChild(el("div")).style.height = "28px";
}

/* ---------- Duplicate finder ---------- */
const normTitle = (t) => t.toLowerCase().replace(/\s*[\(\[][^\)\]]*(remaster|version|mono|stereo|bonus)[^\)\]]*[\)\]]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function findDuplicates() {
  const groups = new Map();
  for (const s of lib.songs) {
    const k = normTitle(s.title) + "|" + normTitle(s._pa);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => a.duration - b.duration);
    // Same song = lengths within 4 seconds. A live version that is much longer is not a duplicate.
    let run = [g[0]];
    const flush = () => { if (run.length > 1) out.push(run.slice().sort((a, b) => (b.size - a.size) || (a.mtime - b.mtime))); };
    for (let i = 1; i < g.length; i++) {
      if (g[i].duration - run[run.length - 1].duration <= 4) run.push(g[i]); else { flush(); run = [g[i]]; }
    }
    flush();
  }
  return out.sort((a, b) => collator.compare(a[0].title, b[0].title));
}
function hideSongs(ids) {
  const set = new Set([...(store.hidden || []), ...ids]);
  store.hidden = [...set];
  saveStore();
  rebuildIndex();
}
function unhideAll() { store.hidden = []; saveStore(); rebuildIndex(); toast("All songs are back"); }
function rebuildIndex() {
  const playing = P.list && P.list[P.i];
  buildIndex(lib.all);
  updateCounts();
  if (typeof renderQueue === "function") renderQueue();
  void playing;
  render(true);
}
const mb = (n) => (n / 1048576).toFixed(1) + " MB";

function viewDupes(sc) {
  const groups = findDuplicates();
  const extra = groups.reduce((t, g) => t + g.length - 1, 0);
  const head = pageHead("Duplicate songs", groups.length ? `${plural(extra, "extra copy", "extra copies")} in ${plural(groups.length, "song")}. Pulse keeps the biggest file and hides the others. Your files stay on your PC.` : "");
  if (groups.length) {
    const all = el("button", "btn primary", "Hide all extra copies");
    all.onclick = () => { hideSongs(groups.flatMap((g) => g.slice(1).map((s) => s.id))); toast(`Hid ${plural(extra, "copy", "copies")}`); };
    const wrapA = el("div", "head-actions"); wrapA.appendChild(all); head.appendChild(wrapA);
  }
  sc.appendChild(head);
  if (!groups.length) return sc.appendChild(emptyState("note", "No duplicates", "Every song in your library appears only once.", null, null, true));
  const box = el("div", "dupes");
  for (const g of groups) {
    const card = el("div", "dupe");
    card.innerHTML = `<div class="d-title"></div>`;
    card.querySelector(".d-title").textContent = g[0].title + " · " + g[0]._pa;
    g.forEach((s, i) => {
      const r = el("div", "d-row" + (i === 0 ? " keep" : ""), `<span class="d-tag">${i === 0 ? "Keeping" : "Extra"}</span><span class="d-info"></span><span class="d-size">${esc(mb(s.size))} · ${esc(fmtTime(s.duration))}</span>`);
      r.querySelector(".d-info").textContent = `${s.album} — ${s.path}`;
      r.querySelector(".d-info").title = s.path;
      if (i > 0) {
        const b = el("button", "btn", "Hide");
        b.onclick = () => hideSongs([s.id]);
        r.appendChild(b);
      }
      card.appendChild(r);
    });
    box.appendChild(card);
  }
  sc.appendChild(box);
  sc.appendChild(el("div")).style.height = "28px";
}

function dupeNotice(sc) {
  if (!lib.songs.length || lib.isDemo) return;
  const n = findDuplicates().reduce((t, g) => t + g.length - 1, 0);
  if (!n) return;
  const b = el("button", "dupe-note", `${icon("file")}<span>You have ${plural(n, "song")} twice.</span><b>Review</b>`);
  b.onclick = () => go({ t: "dupes" });
  sc.appendChild(b);
}
