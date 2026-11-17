/* Views: Home, Songs, Albums, Artists, Liked, detail pages, playlists, search. */
"use strict";

let route = { t: "home" };
const hist = [];
let cur = { lists: [], cleanups: [] };
let sortKey = "title", sortDir = 1;

/* ---------- Routing ---------- */
function go(r, push = true) {
  const si = $("#search");
  if (r.t !== "search" && si.value) si.value = "";
  if (push && route && route.t !== "search") { hist.push(route); if (hist.length > 40) hist.shift(); }
  route = r;
  render();
  updateNav();
}
function back() {
  const r = hist.pop();
  if (!r) return go({ t: "home" }, false);
  route = r; render(); updateNav();
}
const openAlbum = (id) => id && go({ t: "album", id });
const openArtist = (id) => id && go({ t: "artist", id });

function updateNav() {
  const active = route.t === "smart" ? "home" : route.t === "dupes" ? "songs" : route.t === "album" ? "albums" : route.t === "artist" ? "artists" : route.t === "playlist" ? "playlists" : route.t;
  for (const b of document.querySelectorAll(".tab[data-view]")) b.classList.toggle("active", b.dataset.view === active);
}
function updateCounts() {
  $("#c-songs").textContent = lib.songs.length ? lib.songs.length.toLocaleString() : "";
  $("#c-albums").textContent = lib.albums.length ? lib.albums.length.toLocaleString() : "";
  $("#c-artists").textContent = lib.artists.length ? lib.artists.length.toLocaleString() : "";
  $("#c-liked").textContent = likedSongs().length || "";
  $("#c-playlists").textContent = store.playlists.length || "";
}
const likedSongs = () => store.likes.map((id) => lib.byId.get(id)).filter(Boolean);

function destroyView() {
  for (const l of cur.lists) l.destroy();
  for (const c of cur.cleanups) c();
  cur = { lists: [], cleanups: [] };
}
function rebindViews() { for (const l of cur.lists) l.rebind && l.rebind(); }
function onLikesChanged() {
  updateCounts();
  if (route.t === "liked") render(true); else rebindViews();
}
function render(keepScroll) {
  const prev = keepScroll && cur.scroller ? cur.scroller.scrollTop : 0;
  destroyView();
  setGlow(null);
  const v = $("#view");
  v.innerHTML = "";
  const sc = el("div", "scroller");
  v.appendChild(sc);
  cur.scroller = sc;
  const r = route;
  if (r.t === "home") viewHome(sc);
  else if (r.t === "songs") viewSongs(sc);
  else if (r.t === "albums") viewGrid(sc, "Albums", lib.albums, "album");
  else if (r.t === "artists") viewGrid(sc, "Artists", lib.artists, "artist");
  else if (r.t === "liked") viewLiked(sc);
  else if (r.t === "album") viewAlbum(sc, lib.albumById.get(r.id));
  else if (r.t === "artist") viewArtist(sc, lib.artistById.get(r.id));
  else if (r.t === "playlists") viewPlaylists(sc);
  else if (r.t === "lyrics") viewLyrics(sc);
  else if (r.t === "playlist") viewPlaylist(sc, store.playlists.find((p) => p.id === r.id));
  else if (r.t === "search") viewSearch(sc, r.q);
  else if (r.t === "playing") viewPlaying(sc);
  else if (r.t === "smart") viewSmart(sc, r.id);
  else if (r.t === "stats") viewStats(sc);
  else if (r.t === "dupes") viewDupes(sc);
  if (prev) sc.scrollTop = prev;
}
function setGlow(hex) {
  const g = $(".glow");
  if (hex) g.style.setProperty("--glow", tuneColor(hex)); else g.style.removeProperty("--glow");
}

/* ---------- Shared pieces ---------- */
function pageHead(title, sub, actions) {
  const h = el("div", "page-head");
  const left = el("div");
  left.innerHTML = `<h1>${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}`;
  h.appendChild(left);
  if (actions) h.appendChild(actions);
  return h;
}
function actionBar(songs, extra) {
  const a = el("div", "head-actions");
  const play = el("button", "btn primary", icon("play") + "Play");
  const shuf = el("button", "btn", icon("shuffle") + "Shuffle");
  play.onclick = () => playList(songs, 0, { shuffle: false });
  shuf.onclick = () => playList(songs, 0, { shuffle: true });
  a.append(play, shuf);
  if (extra) extra.forEach((x) => a.appendChild(x));
  if (!songs.length) { play.disabled = shuf.disabled = true; }
  return a;
}
function emptyState(iconName, title, text, btnLabel, onClick, inline) {
  const d = el("div", "empty" + (inline ? " inline" : ""));
  d.innerHTML = `<div class="big">${icon(iconName)}</div><h2>${esc(title)}</h2><p>${text}</p>`;
  if (btnLabel) {
    const b = el("button", "btn primary", icon("folder") + esc(btnLabel));
    b.onclick = onClick;
    d.appendChild(b);
  }
  return d;
}
function needFolders(sc) {
  const box = el("div");
  box.style.cssText = "display:flex;min-height:100%;";
  const d = el("div", "empty");
  if (lib.folders.length && !lib.songs.length) {
    d.innerHTML = `<div class="big">${icon("note")}</div><h2>No songs found</h2><p>Pulse looked in your music folders but didn’t find any MP3, M4A, FLAC, OGG or WAV files.</p>`;
  } else {
    d.innerHTML = `<div class="big">${icon("drop")}</div><h2>Bring in your music</h2><p>Add a few songs, hundreds at once, or a whole folder. Pulse reads the titles and cover art, then opens instantly every time after.</p>`;
  }
  const row = el("div", "btn-row");
  const s = el("button", "btn primary", icon("file") + "Add songs");
  const f = el("button", "btn", icon("folder") + "Add folder");
  s.onclick = addSongs; f.onclick = addFolder;
  row.append(s, f);
  d.appendChild(row);
  d.appendChild(el("p", "hint", "or drag and drop them anywhere in this window"));
  box.appendChild(d);
  sc.appendChild(box);
}

/* ---------- Song list ---------- */
function songHeader(opts, onSort) {
  const h = el("div", "list-head cols" + (opts.noAlbum ? " no-album" : ""));
  const arrow = (k) => (opts.sortable && sortKey === k ? (sortDir > 0 ? " ↑" : " ↓") : "");
  h.innerHTML = `<div style="text-align:center">#</div><div data-sort="title">Title${arrow("title")}</div><div class="t-album" data-sort="album">Album${arrow("album")}</div><div></div><div class="r" data-sort="time">${icon("clock")}</div><div></div>`;
  if (opts.sortable) {
    h.style.cursor = "default";
    h.addEventListener("click", (e) => { const k = e.target.closest("[data-sort]"); if (k) onSort(k.dataset.sort); });
    for (const n of h.querySelectorAll("[data-sort]")) n.style.cursor = "pointer";
  }
  return h;
}
function songList(sc, songs, opts = {}) {
  const host = el("div");
  host.classList.add("songs");
  sc.appendChild(host);
  const sel = new Set();
  let anchor = -1;
  const vl = VList({
    scroller: sc, host, count: songs.length, h: 56,
    create() {
      const r = el("div", "row cols" + (opts.noAlbum ? " no-album" : ""));
      r.innerHTML = `<div class="idx"><span class="num"></span><span class="eq"><i></i><i></i><i></i><i></i><i></i></span>${icon("play", "play-ico")}</div>
        <div class="t-cell"><div class="t-text"><div class="t-title"></div><div class="t-sub"><span class="link"></span></div></div></div>
        <div class="t-album"><span class="link"></span></div>
        <button class="icon-btn small rlike" aria-label="Like"></button>
        <div class="t-dur"></div>
        <button class="icon-btn small more" aria-label="More">${icon("more")}</button>`;
      r.querySelector(".t-cell").prepend(coverEl("s40"));
      return r;
    },
    bind(r, i) {
      const s = songs[i];
      const playing = !!curSong() && curSong().id === s.id;
      r.classList.toggle("playing", playing);
      r.classList.toggle("selected", sel.has(i));
      r.querySelector(".num").textContent = i + 1;
      setCover(r.querySelector(".cover"), s.cover, s.album);
      r.querySelector(".t-title").textContent = s.title;
      r.querySelector(".t-sub .link").textContent = artistLabel(s.artist);
      r.querySelector(".t-album .link").textContent = s.album;
      const like = r.querySelector(".rlike"), on = isLiked(s.id);
      like.innerHTML = icon(on ? "heart-fill" : "heart");
      like.classList.toggle("on", on);
      like.style.opacity = on ? 1 : "";
      r.querySelector(".t-dur").textContent = fmtTime(s.duration);
    },
  });
  const rowOf = (e) => { const r = e.target.closest(".row"); return r ? { r, s: songs[r._i] } : null; };
  host.addEventListener("click", (e) => {
    const x = rowOf(e); if (!x) return;
    if (e.target.closest(".rlike")) return toggleLike(x.s.id);
    if (e.target.closest(".more")) { const b = e.target.closest(".more").getBoundingClientRect(); return songMenu(b.left - 180, b.bottom + 4, x.s, songs, opts, pickGroup(x.s, x.r._i)); }
    if (e.target.closest(".idx")) return playSong(x.s, songs);
    const lk = e.target.closest(".link");
    if (lk && lk.closest(".t-sub")) return openArtist(lib.artists.find((a) => a.name === x.s._pa)?.id);
    if (lk && lk.closest(".t-album")) return openAlbum(x.s._album.id);
    const i = x.r._i;
    if (e.shiftKey && anchor >= 0) { sel.clear(); for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) sel.add(k); }
    else if (e.ctrlKey || e.metaKey) { sel.has(i) ? sel.delete(i) : sel.add(i); anchor = i; }
    else { sel.clear(); sel.add(i); anchor = i; }
    vl.rebind();
  });
  host.addEventListener("dblclick", (e) => { const x = rowOf(e); if (x && !e.target.closest("button,.link")) playSong(x.s, songs); });
  host.addEventListener("contextmenu", (e) => { const x = rowOf(e); if (x) { e.preventDefault(); if (!sel.has(x.r._i)) { sel.clear(); sel.add(x.r._i); anchor = x.r._i; vl.rebind(); } songMenu(e.clientX, e.clientY, x.s, songs, opts, pickGroup(x.s, x.r._i)); } });
  const pickGroup = (s, i) => (sel.size > 1 && sel.has(i) ? [...sel].sort((a, b) => a - b).map((k) => songs[k]) : [s]);
  host._dnd = { songs, sel, opts, vl, h: 56 };
  // Used by the playlist search box: swap the list that is shown without rebuilding the page.
  vl.setSongs = (arr, canReorder) => {
    songs = arr; sel.clear(); anchor = -1;
    host._dnd.songs = arr;
    host._dnd.opts = canReorder === false ? { ...opts, playlistId: null } : opts;
    vl.setCount(arr.length);
  };
  cur.lists.push(vl);
  return vl;
}

function songMenu(x, y, s, context, opts = {}, group) {
  group = group && group.length ? group : [s];
  const many = group.length > 1, ids = group.map((g) => g.id);
  const head = many ? plural(group.length, "song") : "";
  const items = [
    { label: many ? `Play ${head}` : "Play", icon: "play", run: () => playSong(group[0], many ? group : context) },
    { label: "Play next", icon: "queue", run: () => enqueue(group, "next") },
    { label: "Add to queue", icon: "list", run: () => enqueue(group, "end") },
    "-",
    { label: many ? `Add ${head} to playlist` : "Add to playlist" },
    ...store.playlists.slice(0, 7).map((p) => ({ label: p.name, icon: "list", run: () => addToPlaylist(p.id, ids) })),
    { label: "New playlist…", icon: "plus", run: () => promptName("New playlist", "", (n) => { const p = createPlaylist(n); addToPlaylist(p.id, ids); }) },
  ];
  if (!many) items.push(
    "-",
    { label: isLiked(s.id) ? "Remove from Liked songs" : "Add to Liked songs", icon: isLiked(s.id) ? "heart-fill" : "heart", run: () => toggleLike(s.id) },
    { label: "Go to album", icon: "album", run: () => openAlbum(s._album.id) },
    { label: "Go to artist", icon: "artist", run: () => openArtist(lib.artists.find((a) => a.name === s._pa)?.id) },
  );
  if (opts.playlistId) items.push("-", { label: many ? `Remove ${head} from this playlist` : "Remove from this playlist", icon: "trash", danger: true, run: () => removeFromPlaylist(opts.playlistId, ids) });
  openMenu(x, y, items);
}

/* ---------- Grid of albums / artists ---------- */
function layoutCols(width, minW, gap) {
  const n = Math.max(2, Math.floor((width + gap) / (minW + gap)));
  return { n, cw: (width - (n - 1) * gap) / n };
}
function cardNode(kind, cw) {
  const c = el("div", "card" + (kind === "artist" ? " round" : ""));
  c.style.flex = `0 0 ${cw}px`;
  c.innerHTML = `<div class="c-cover"></div><div class="c-title"></div><div class="c-sub"></div><button class="fab" aria-label="Play">${icon("play")}</button>`;
  c.firstChild.replaceWith(coverEl(""));
  return c;
}
function bindCard(c, kind, item) {
  if (!item) { c.style.visibility = "hidden"; c._item = null; return; }
  c.style.visibility = "";
  c._item = item;
  setCover(c.querySelector(".cover"), item.cover, item.name, kind === "artist" ? item.name.trim()[0] : "");
  c.querySelector(".c-title").textContent = item.name;
  c.querySelector(".c-sub").textContent = kind === "album"
    ? `${item.artist}${item.year ? " · " + item.year : ""}`
    : plural(item.songs.length, "song");
}
function cardActions(host, kind) {
  const open = (it) => (kind === "album" ? openAlbum(it.id) : openArtist(it.id));
  host.addEventListener("click", (e) => {
    const c = e.target.closest(".card"); if (!c || !c._item) return;
    if (e.target.closest(".fab")) playList(c._item.songs, 0, { shuffle: false }); else open(c._item);
  });
  host.addEventListener("contextmenu", (e) => {
    const c = e.target.closest(".card"); if (!c || !c._item) return;
    e.preventDefault();
    const it = c._item;
    openMenu(e.clientX, e.clientY, [
      { label: "Play", icon: "play", run: () => playList(it.songs, 0, { shuffle: false }) },
      { label: "Shuffle", icon: "shuffle", run: () => playList(it.songs, 0, { shuffle: true }) },
      { label: "Play next", icon: "queue", run: () => enqueue(it.songs, "next") },
      { label: "Add to queue", icon: "list", run: () => enqueue(it.songs, "end") },
    ]);
  });
}
function cardGrid(sc, items, kind) {
  const wrap = el("div", "grid-wrap");
  sc.appendChild(wrap);
  let vl = null, cols = 0, ro;
  const gap = 4, pad = 16, minW = kind === "artist" ? 160 : 176;
  function build() {
    const width = wrap.clientWidth - pad;
    if (width <= 0) return;
    const { n, cw } = layoutCols(width, minW, gap);
    if (vl && n === cols && wrap._w === Math.round(cw)) return;
    cols = n; wrap._w = Math.round(cw);
    if (vl) { vl.destroy(); cur.lists = cur.lists.filter((l) => l !== vl); wrap.innerHTML = ""; }
    const host = el("div");
    wrap.appendChild(host);
    host.style.setProperty("--cw", cw - 20 + "px");
    vl = VList({
      scroller: sc, host, count: Math.ceil(items.length / n), h: cw + 62, overscan: 2,
      create() {
        const r = el("div", "grid-row");
        for (let k = 0; k < n; k++) r.appendChild(cardNode(kind, cw));
        return r;
      },
      bind(r, i) { [...r.children].forEach((c, k) => bindCard(c, kind, items[i * n + k])); },
    });
    cardActions(host, kind);
    cur.lists.push(vl);
  }
  ro = new ResizeObserver(build);
  ro.observe(wrap);
  cur.cleanups.push(() => ro.disconnect());
  build();
}
function viewGrid(sc, title, items, kind) {
  sc.appendChild(pageHead(title, items.length ? plural(items.length, kind === "album" ? "album" : "artist") : ""));
  if (!items.length) return needFolders(sc);
  cardGrid(sc, items, kind);
}

/* A single row of cards (Home, Artist, Search) that fits the window width. */
function shelf(sc, title, items, kind, minW = 160) {
  if (!items.length) return;
  const box = el("div");
  box.innerHTML = `<div class="shelf-title">${esc(title)}</div>`;
  const row = el("div", "grid-row");
  row.style.cssText = "padding:0 30px 4px";
  box.appendChild(row);
  sc.appendChild(box);
  const render = () => {
    const width = box.clientWidth - 60;
    if (width <= 0) return;
    const { n, cw } = layoutCols(width, minW, 4);
    row.innerHTML = "";
    row.style.setProperty("--cw", cw - 20 + "px");
    for (const it of items.slice(0, n)) { const c = cardNode(kind, cw); bindCard(c, kind, it); row.appendChild(c); }
  };
  cardActions(row, kind);
  const ro = new ResizeObserver(render);
  ro.observe(box);
  cur.cleanups.push(() => ro.disconnect());
  render();
}

/* ---------- Pages ---------- */
function viewHome(sc) {
  if (!lib.songs.length) return needFolders(sc);
  const hr = new Date().getHours();
  const hi = hr < 5 ? "Still up?" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
  const hero = el("div", "home-hero");
  hero.innerHTML = `<h1>${hi}</h1><p>${plural(lib.songs.length, "song")} from ${plural(lib.artists.length, "artist")}, ready when you are.</p>`;
  if (!IS_APP && lib.isDemo) hero.querySelector("p").textContent = "You’re listening to demo songs. Add your own to see Pulse with your music.";
  sc.appendChild(hero);

  const recentAlbums = [];
  for (const id of store.recent) {
    const s = lib.byId.get(id);
    if (s && !recentAlbums.includes(s._album)) recentAlbums.push(s._album);
  }
  // Feature card: continue with the last album, or start with a random one.
  const last = store.last && lib.byId.get(store.last.id);
  const day = Math.floor(Date.now() / 864e5);
  const featAlbum = (last && last._album) || lib.albums.slice().sort((x, y) => hash(x.id + day) - hash(y.id + day))[0];
  if (featAlbum) {
    const f = el("div", "feature");
    f.style.setProperty("--f", tuneColor(featAlbum.color));
    const cv = coverEl("");
    setCover(cv, featAlbum.cover, featAlbum.name);
    const info = el("div");
    info.style.minWidth = 0;
    info.innerHTML = `<div class="f-kind">${last ? "Pick up where you left off" : "Start with this album"}</div><h2>${esc(featAlbum.name)}</h2><div class="f-sub">${esc(featAlbum.artist)}${featAlbum.year ? " · " + featAlbum.year : ""} · ${plural(featAlbum.songs.length, "song")}</div>`;
    const act = el("div", "head-actions");
    const play = el("button", "btn primary", icon("play") + (last ? "Resume" : "Play album"));
    const shuf = el("button", "btn", icon("shuffle") + "Shuffle everything");
    play.onclick = () => {
      if (last && last._album === featAlbum) { const i = featAlbum.songs.indexOf(last); playList(featAlbum.songs, Math.max(0, i), { shuffle: false }); }
      else playList(featAlbum.songs, 0, { shuffle: false });
    };
    shuf.onclick = () => playList(lib.sorted, 0, { shuffle: true });
    act.append(play, shuf);
    info.appendChild(act);
    f.append(cv, info);
    f.style.cursor = "default";
    cv.style.cursor = "pointer";
    cv.onclick = () => openAlbum(featAlbum.id);
    sc.appendChild(f);
  }

  dupeNotice(sc);
  smartShelf(sc);
  const quickAlbums = recentAlbums.filter((a) => a !== featAlbum).slice(0, 6);
  if (quickAlbums.length) {
    sc.appendChild(el("div", "shelf-title", "Jump back in"));
    const q = el("div", "quick");
    q.style.paddingTop = "6px";
    for (const al of quickAlbums) {
      const b = el("button", "quick-item", `<div class="q-cover"></div><div style="min-width:0"><div class="q-t"></div><div class="q-s"></div></div>`);
      b.firstChild.replaceWith(coverEl(""));
      setCover(b.querySelector(".cover"), al.cover, al.name);
      b.querySelector(".q-t").textContent = al.name;
      b.querySelector(".q-s").textContent = al.artist;
      b.onclick = () => playList(al.songs, 0, { shuffle: false });
      q.appendChild(b);
    }
    sc.appendChild(q);
  }
  shelf(sc, "Recently added", lib.albums.slice().sort((x, y) => y.added - x.added), "album");
  const pick = lib.artists.slice().sort((x, y) => hash(x.id + day) - hash(y.id + day));
  shelf(sc, "Artists to revisit", pick, "artist");
  sc.appendChild(el("div")).style.height = "28px";
}

function viewSongs(sc) {
  const songs = lib.sorted.slice();
  const total = songs.reduce((t, s) => t + s.duration, 0);
  sc.appendChild(pageHead("Songs", songs.length ? `${plural(songs.length, "song")} · ${fmtTotal(total)}` : "", songs.length ? actionBar(lib.sorted) : null));
  if (!songs.length) return needFolders(sc);
  const apply = () => {
    const d = sortDir;
    const cmp = {
      title: (a, b) => collator.compare(a.title, b.title),
      album: (a, b) => collator.compare(a.album, b.album) || a.disc - b.disc || a.track - b.track,
      time: (a, b) => a.duration - b.duration,
    }[sortKey];
    songs.sort((a, b) => d * cmp(a, b));
  };
  apply();
  let head = songHeader({ sortable: true }, onSort);
  sc.appendChild(head);
  let vl = songList(sc, songs, {});
  function onSort(k) {
    if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; }
    apply();
    const nh = songHeader({ sortable: true }, onSort);
    head.replaceWith(nh); head = nh;
    vl.rebind();
  }
}

function viewLiked(sc) {
  const songs = likedSongs();
  const total = songs.reduce((t, s) => t + s.duration, 0);
  sc.appendChild(pageHead("Liked songs", songs.length ? `${plural(songs.length, "song")} · ${fmtTotal(total)}` : "", songs.length ? actionBar(songs) : null));
  if (!songs.length) return sc.appendChild(emptyState("heart", "Nothing liked yet", "Tap the heart next to any song, or press L while it plays. Your favourites will gather here.", null, null, true));
  sc.appendChild(songHeader({}));
  songList(sc, songs, {});
}

function detailHero(sc, { kind, title, round, cover, seed, metaHtml, songs, extra }) {
  const hero = el("div", "hero" + (round ? " round" : ""));
  const bk = el("button", "icon-btn back", icon("chev"));
  bk.setAttribute("aria-label", "Back");
  bk.onclick = back;
  const cv = coverEl("");
  setCover(cv, cover, seed, round ? title.trim()[0] : "");
  const info = el("div");
  info.style.minWidth = 0;
  info.innerHTML = `<div class="kind">${esc(kind)}</div><h1>${esc(title)}</h1><div class="meta">${metaHtml}</div>`;
  info.appendChild(actionBar(songs, extra));
  hero.append(bk, cv, info);
  sc.appendChild(hero);
}
function viewAlbum(sc, al) {
  if (!al) return back();
  setGlow(al.color);
  detailHero(sc, {
    kind: "Album", title: al.name, cover: al.cover, seed: al.name, songs: al.songs,
    metaHtml: `<span class="link" data-artist>${esc(al.artist)}</span>${al.year ? " · " + al.year : ""} · ${plural(al.songs.length, "song")} · ${fmtTotal(al.duration)}`,
  });
  sc.querySelector("[data-artist]").onclick = () => openArtist(lib.artists.find((a) => a.name === primaryArtist(al.artist))?.id);
  sc.appendChild(songHeader({ noAlbum: true }));
  songList(sc, al.songs, { noAlbum: true });
  sc.appendChild(el("div")).style.height = "24px";
}
function viewArtist(sc, ar) {
  if (!ar) return back();
  setGlow(ar.color);
  detailHero(sc, {
    kind: "Artist", title: ar.name, round: true, cover: ar.cover, seed: ar.name, songs: ar.songs,
    metaHtml: `${plural(ar.songs.length, "song")} · ${plural(ar.albums.length, "album")} · ${fmtTotal(ar.duration)}`,
  });
  shelf(sc, "Albums", ar.albums, "album");
  sc.appendChild(el("div", "shelf-title", "Songs"));
  const songs = ar.songs.slice().sort((a, b) => collator.compare(a.album, b.album) || a.track - b.track);
  sc.appendChild(songHeader({}));
  songList(sc, songs, {});
  sc.appendChild(el("div")).style.height = "24px";
}
function viewPlaylist(sc, pl) {
  if (!pl) return go({ t: "playlists" }, false);
  const songs = pl.ids.map((id) => lib.byId.get(id)).filter(Boolean);
  const first = songs.find((s) => s.cover);
  if (first) setGlow(first.color);
  const add = el("button", "btn", icon("plus") + "Add songs"), ren = el("button", "btn", "Rename"), del = el("button", "btn", "Delete");
  add.onclick = () => addSongs(pl.id);
  ren.onclick = () => promptName("Rename playlist", pl.name, (n) => renamePlaylist(pl.id, n));
  del.onclick = () => confirmModal("Delete playlist?", `“${pl.name}” will be removed. Your songs stay where they are.`, "Delete", () => deletePlaylist(pl.id));
  detailHero(sc, {
    kind: "Playlist", title: pl.name, cover: first && first.cover, seed: pl.name, songs, extra: [add, ren, del],
    metaHtml: songs.length ? `${plural(songs.length, "song")} · ${fmtTotal(songs.reduce((t, s) => t + s.duration, 0))}` : "Empty",
  });
  if (!songs.length) return sc.appendChild(emptyState("drop", "Drop songs here", "Drag songs or folders from your PC onto this page, or drag songs from your library onto this playlist.", "Add songs", () => addSongs(pl.id), true));
  // Search only inside this playlist.
  const box = el("div", "pl-search", `${icon("search")}<input type="text" placeholder="Search in ${esc(pl.name)}" spellcheck="false" aria-label="Search in this playlist"><button class="icon-btn small" aria-label="Clear" hidden>${icon("close")}</button>`);
  const inp = box.querySelector("input"), clr = box.querySelector("button");
  sc.appendChild(box);
  sc.appendChild(songHeader({}));
  const vl = songList(sc, songs, { playlistId: pl.id });
  const none = el("div", "pl-none");
  sc.appendChild(none);
  const apply = () => {
    const q = inp.value.trim().toLowerCase();
    plQuery = { id: pl.id, q: inp.value };
    clr.hidden = !q;
    const hit = q ? songs.filter((s) => `${s.title} ${s.artist} ${s.album}`.toLowerCase().includes(q)) : songs;
    vl.setSongs(hit, !q);
    none.textContent = q && !hit.length ? `No song in this playlist matches “${inp.value.trim()}”.` : "";
  };
  inp.oninput = apply;
  inp.onkeydown = (e) => { if (e.key === "Escape") { inp.value = ""; apply(); } e.stopPropagation(); };
  clr.onclick = () => { inp.value = ""; apply(); inp.focus(); };
  if (plQuery.id === pl.id && plQuery.q) { inp.value = plQuery.q; apply(); }
}
let plQuery = { id: "", q: "" };

const newPlaylistDialog = () => promptName("New playlist", "", (n) => { const p = createPlaylist(n); go({ t: "playlist", id: p.id }); });
function playlistMenu(x, y, p) {
  openMenu(x, y, [
    { label: "Play", icon: "play", run: () => playList(p.ids.map((i) => lib.byId.get(i)).filter(Boolean), 0, { fresh: true }) },
    { label: "Add songs…", icon: "plus", run: () => addSongs(p.id) },
    { label: "Rename", icon: "list", run: () => promptName("Rename playlist", p.name, (n) => renamePlaylist(p.id, n)) },
    { label: "Delete", icon: "trash", danger: true, run: () => confirmModal("Delete playlist?", `“${p.name}” will be removed. Your songs stay where they are.`, "Delete", () => deletePlaylist(p.id)) },
  ]);
}
let openTimer = 0;
function viewPlaylists(sc) {
  const mk = el("div", "head-actions");
  const nb = el("button", "btn primary", icon("plus") + "New playlist");
  nb.onclick = newPlaylistDialog;
  mk.appendChild(nb);
  sc.appendChild(pageHead("Playlists", store.playlists.length ? plural(store.playlists.length, "playlist") : "", mk));
  if (!store.playlists.length)
    return sc.appendChild(emptyState("list", "No playlists yet", "Make one, then drag songs onto it: from your library, or straight from a folder on your PC.", "New playlist", newPlaylistDialog, true));
  const grid = el("div", "pl-grid");
  for (const p of store.playlists) {
    const songs = p.ids.map((i) => lib.byId.get(i)).filter(Boolean);
    const first = songs.find((s) => s.cover);
    const c = el("div", "pl-card");
    c.dataset.pl = p.id;
    c.tabIndex = 0;
    const cv = coverEl("");
    setCover(cv, first && first.cover, p.name);
    const wrap = el("div", "pl-cover");
    wrap.appendChild(cv);
    const pb = el("button", "pl-play", icon("play"));
    pb.setAttribute("aria-label", "Play " + p.name);
    pb.onclick = (e) => { e.stopPropagation(); clearTimeout(openTimer); if (songs.length) playList(songs, 0, { fresh: true }); };
    wrap.appendChild(pb);
    c.append(wrap, el("div", "pl-name", esc(p.name)), el("div", "pl-sub", songs.length ? plural(songs.length, "song") : "Empty"));
    // One click opens the playlist. Double click plays it (shuffled if Shuffle is on).
    c.onclick = (e) => {
      clearTimeout(openTimer);
      if (e.detail >= 2) { if (songs.length) playList(songs, 0, { fresh: true }); else toast("This playlist is empty"); return; }
      openTimer = setTimeout(() => go({ t: "playlist", id: p.id }), 300);
    };
    c.onkeydown = (e) => { if (e.key === "Enter") go({ t: "playlist", id: p.id }); };
    c.oncontextmenu = (e) => { e.preventDefault(); playlistMenu(e.clientX, e.clientY, p); };
    grid.appendChild(c);
  }
  sc.appendChild(grid);
}

/* ---------- Playlists ---------- */
/** The Playlists tab and its count follow the data. */
function renderPlaylistNav() {
  updateCounts();
  if (route.t === "playlists") render(true);
}
function createPlaylist(name) {
  const p = { id: "pl" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: name.trim() || "New playlist", ids: [] };
  store.playlists.push(p);
  saveStore(); renderPlaylistNav();
  return p;
}
function renamePlaylist(id, name) {
  const p = store.playlists.find((x) => x.id === id);
  if (p && name.trim()) { p.name = name.trim(); saveStore(); renderPlaylistNav(); if (route.t === "playlist") render(true); }
}
function deletePlaylist(id) {
  store.playlists = store.playlists.filter((p) => p.id !== id);
  saveStore();
  if (route.t === "playlist" && route.id === id) go({ t: "playlists" }, false); else renderPlaylistNav();
  toast("Playlist deleted");
}
/** Adds any number of songs. Songs already inside are skipped. */
function addToPlaylist(id, ids) {
  const p = store.playlists.find((x) => x.id === id);
  if (!p) return 0;
  const have = new Set(p.ids), fresh = [];
  for (const i of ids) if (!have.has(i)) { have.add(i); fresh.push(i); }
  for (const i of fresh) p.ids.push(i);
  if (fresh.length) saveStore();
  renderPlaylistNav();
  toast(fresh.length ? `Added ${plural(fresh.length, "song")} to ${p.name}` : `Already in ${p.name}`);
  if (route.t === "playlist" && route.id === id) render(true);
  return fresh.length;
}
function removeFromPlaylist(id, songIds) {
  const p = store.playlists.find((x) => x.id === id);
  if (!p) return;
  const gone = new Set([].concat(songIds));
  p.ids = p.ids.filter((i) => !gone.has(i));
  saveStore(); renderPlaylistNav();
  render(true);
}
/** Moves songs (by id) so they sit before position `at` of the songs that are showing. */
function movePlaylistSongs(id, moving, at) {
  const p = store.playlists.find((x) => x.id === id);
  if (!p) return;
  const m = new Set(moving);
  const shown = p.ids.filter((i) => lib.byId.has(i));
  const before = shown.slice(0, at).filter((i) => !m.has(i));
  const after = shown.slice(at).filter((i) => !m.has(i));
  const hidden = p.ids.filter((i) => !lib.byId.has(i));
  p.ids = [...before, ...shown.filter((i) => m.has(i)), ...after, ...hidden];
  saveStore();
  render(true);
}

/* ---------- Search ---------- */
function viewSearch(sc, q) {
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  const songs = lib.songs.filter((s) => tokens.every((t) => s._k.includes(t)));
  const low = q.toLowerCase();
  songs.sort((a, b) => (b.title.toLowerCase().startsWith(low) - a.title.toLowerCase().startsWith(low)) || collator.compare(a.title, b.title));
  const albums = lib.albums.filter((a) => tokens.every((t) => (a.name + " " + a.artist).toLowerCase().includes(t)));
  const artists = lib.artists.filter((a) => tokens.every((t) => a.name.toLowerCase().includes(t)));
  sc.appendChild(pageHead(`Results for “${q}”`, `${plural(songs.length, "song")}, ${plural(albums.length, "album")}, ${plural(artists.length, "artist")}`));
  if (!songs.length && !albums.length && !artists.length)
    return sc.appendChild(emptyState("search", "Nothing matched", "Check the spelling, or try just part of a title, artist or album.", null, null, true));
  shelf(sc, "Albums", albums, "album", 128);
  shelf(sc, "Artists", artists, "artist", 128);
  if (songs.length) {
    sc.appendChild(el("div", "shelf-title", "Songs"));
    sc.appendChild(songHeader({}));
    songList(sc, songs, {});
    sc.appendChild(el("div")).style.height = "24px";
  }
}

/* ---------- Dialogs ---------- */
function promptName(title, initial, cb) {
  const d = el("div", "dialog");
  d.innerHTML = `<h3>${esc(title)}</h3><input class="field" maxlength="60" placeholder="Playlist name" value="${esc(initial)}"><div class="actions"><button class="btn" data-x>Cancel</button><button class="btn primary" data-ok>Save</button></div>`;
  const input = d.querySelector("input");
  const ok = () => { const v = input.value.trim(); if (!v) return input.focus(); closeModal(); cb(v); };
  d.querySelector("[data-x]").onclick = closeModal;
  d.querySelector("[data-ok]").onclick = ok;
  input.onkeydown = (e) => { if (e.key === "Enter") ok(); };
  openModal(d);
  input.select();
}
function confirmModal(title, text, okLabel, cb) {
  const d = el("div", "dialog");
  d.innerHTML = `<h3>${esc(title)}</h3><p class="note">${esc(text)}</p><div class="actions"><button class="btn" data-x>Cancel</button><button class="btn primary" data-ok>${esc(okLabel)}</button></div>`;
  d.querySelector("[data-x]").onclick = closeModal;
  d.querySelector("[data-ok]").onclick = () => { closeModal(); cb(); };
  openModal(d);
}
