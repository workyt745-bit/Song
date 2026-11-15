/* Main: start-up, window controls, search, keyboard, scanning, folder management. */
"use strict";

let scanning = false;
const sig = (songs) => songs.length + ":" + songs.reduce((t, s) => t + s.mtime, 0);
const uniq = (a) => [...new Set(a)];
const AUDIO_EXTS = ["mp3", "m4a", "aac", "flac", "ogg", "opus", "wav"];

/** Desktop app: reads folders and single songs with the Rust back end. */
async function rescan(folders, { silent, files } = {}) {
  if (scanning) { if (!silent) toast("Still reading your library. Try again in a moment."); return; }
  files = files || lib.files;
  scanning = true;
  const box = $("#scan-status");
  $("#scan-text").textContent = "Checking for changes…";
  $("#scan-fill").style.width = "0";
  box.hidden = false;
  const before = sig(lib.all), had = lib.all.length;
  try {
    const songs = await invoke("scan_library", { folders, files });
    lib.folders = folders;
    lib.files = files;
    if (sig(songs) !== before || !silent) {
      buildIndex(songs);
      updateCounts();
      render(true);
      renderQueue();
      if (!silent) {
        const diff = songs.length - had;
        toast(diff > 0 ? `Added ${plural(diff, "song")}` : diff < 0 ? `Removed ${plural(-diff, "song")}` : `Library is up to date`);
      }
      if (typeof restoreLast === "function") restoreLast();
    }
  } catch (e) {
    toast("Couldn’t read that. Check that it still exists.");
    console.error(e);
  } finally {
    scanning = false;
    box.hidden = true;
  }
}

/** Desktop app: files and folders from the picker or from a drop. */
async function addPaths(paths, playlistId) {
  if (!paths || !paths.length) return;
  const s = await invoke("classify_paths", { paths });
  if (!s.folders.length && !s.files.length) return toast("Those aren’t songs. Pulse plays MP3, M4A, FLAC, OGG and WAV.");
  await rescan(uniq([...lib.folders, ...s.folders]), { files: uniq([...lib.files, ...s.files]), silent: !!playlistId });
  if (playlistId) addToPlaylist(playlistId, idsForPaths(s));
}
/** Songs that came from the dropped files (in the order dropped) and from the dropped folders. */
function idsForPaths(s) {
  const n = (p) => p.replace(/\\/g, "/").toLowerCase();
  const byPath = new Map(lib.songs.map((x) => [n(x.path), x.id]));
  const out = [];
  for (const f of s.files) { const id = byPath.get(n(f)); if (id) out.push(id); }
  const dirs = s.folders.map((f) => n(f).replace(/\/$/, "") + "/");
  if (dirs.length) for (const x of lib.songs) { const p = n(x.path); if (dirs.some((d) => p.startsWith(d))) out.push(x.id); }
  return out;
}

/** One song, or hundreds: pick as many files as you like. */
async function addSongs(playlistId) {
  if (typeof playlistId !== "string") playlistId = null;
  if (!IS_APP) { pendingPlaylist = playlistId; return pickBrowserFiles(); }
  const picked = await TAURI.dialog.open({ multiple: true, title: "Choose songs", filters: [{ name: "Songs", extensions: AUDIO_EXTS }] });
  if (picked) await addPaths(Array.isArray(picked) ? picked : [picked], playlistId);
}
/** A whole folder, including every folder inside it. */
async function addFolder() {
  if (!IS_APP) return pickBrowserFolder();
  const picked = await TAURI.dialog.open({ directory: true, multiple: true, title: "Choose your music folders" });
  if (picked) await addPaths(Array.isArray(picked) ? picked : [picked]);
}
function openAddMenu() {
  const r = $("#add-music").getBoundingClientRect();
  openMenu(r.right - 190, r.bottom + 6, [
    { label: "Add songs…", icon: "file", run: addSongs },
    { label: "Add a folder…", icon: "folder", run: addFolder },
  ]);
}

function manageFolders() {
  const d = el("div", "dialog");
  const draw = () => {
    d.innerHTML = `<h3>Your library</h3>
      <p class="note">${IS_APP
        ? "Pulse remembers these. Folders include every folder inside them, and new songs show up the next time you open the app."
        : "This is the browser preview, so the songs you add are forgotten when you close the page. The desktop app remembers everything."}</p>
      <div class="folder-list"></div>
      <label class="switch-row"><span>Show artist photos<small>Downloaded once for each artist, a few MB at most, then kept on your PC.</small></span><input type="checkbox" class="switch" data-photos ${store.photos !== false ? "checked" : ""}></label>
      <label class="switch-row"><span>Find lyrics online<small>Looked up once for each song you play (a few KB), then kept on your PC.</small></span><input type="checkbox" class="switch" data-lyrics ${store.lyrics !== false ? "checked" : ""}></label>
      <label class="switch-row"><span>Keep playing when I close the window<small>Pulse hides in the tray (by the clock). Click its icon to open it, or right-click to quit.</small></span><input type="checkbox" class="switch" data-tray ${store.tray !== false ? "checked" : ""}></label>
      <p class="note">Keys that work in any app: <b>Ctrl + Alt + →</b> next, <b>Ctrl + Alt + ←</b> previous, <b>Ctrl + Alt + Space</b> play or pause.</p>
      <div class="switch-row"><span>Duplicate songs<small>${(store.hidden || []).length ? plural(store.hidden.length, "song") + " hidden. Your files are never deleted." : "Find songs you have twice and hide the extra copies."}</small></span><div class="btn-row" style="margin:0"><button class="btn" data-dupes>Find</button>${(store.hidden || []).length ? '<button class="btn" data-unhide>Show all again</button>' : ""}</div></div>
      <div class="switch-row"><span>Start over<small>Clears Pulse: your playlists, likes, stats and song list. Your music files on the PC are not touched.</small></span><button class="btn danger" data-reset>Reset Pulse</button></div>
      <div class="actions"><button class="btn" data-rescan>Rescan</button><button class="btn" data-songs>${icon("file")}Add songs</button><button class="btn primary" data-folder>${icon("folder")}Add folder</button><button class="btn" data-x>Done</button></div>`;
    const list = d.querySelector(".folder-list");
    const row = (ic, text, onRemove) => {
      const r = el("div", "folder-item", `${icon(ic)}<span class="p" title="${esc(text)}">${esc(text)}</span><button class="icon-btn small" aria-label="Remove">${icon("close")}</button>`);
      r.querySelector("button").onclick = onRemove;
      list.appendChild(r);
    };
    if (IS_APP) {
      lib.folders.forEach((f) => row("folder", f, async () => { await rescan(lib.folders.filter((x) => x !== f)); draw(); }));
      if (lib.files.length) row("file", `${plural(lib.files.length, "song")} added one by one`, async () => { await rescan(lib.folders, { files: [] }); draw(); });
      if (!lib.folders.length && !lib.files.length) list.innerHTML = `<p class="note">Nothing added yet.</p>`;
    } else if (lib.isDemo) {
      list.innerHTML = `<p class="note">You are listening to demo songs.</p>`;
    } else {
      row("note", `${plural(lib.songs.length, "song")} loaded`, () => { useDemoSongs(); draw(); });
    }
    d.querySelector("[data-photos]").onchange = (e) => { store.photos = e.target.checked; saveStore(); if (route.t === "playing") render(false); };
    d.querySelector("[data-lyrics]").onchange = (e) => { store.lyrics = e.target.checked; saveStore(); if (e.target.checked && typeof prefetchLyrics === "function") prefetchLyrics(); if (route.t === "lyrics") render(false); };
    d.querySelector("[data-reset]").onclick = () => confirmModal("Reset Pulse?", "This clears all your playlists, likes, play counts and the song list inside Pulse, then Pulse starts fresh. Your music files on the PC stay exactly where they are.", "Reset", resetApp);
    const tr = d.querySelector("[data-tray]");
    tr.onchange = () => { store.tray = tr.checked; saveStore(); if (IS_APP) invoke("set_close_to_tray", { on: tr.checked }); };
    d.querySelector("[data-x]").onclick = closeModal;
    d.querySelector("[data-dupes]").onclick = () => { closeModal(); go({ t: "dupes" }); };
    const uh = d.querySelector("[data-unhide]");
    if (uh) uh.onclick = () => { unhideAll(); draw(); };
    d.querySelector("[data-songs]").onclick = async () => { if (!IS_APP) closeModal(); await addSongs(); if (IS_APP) draw(); };
    d.querySelector("[data-folder]").onclick = async () => { if (!IS_APP) closeModal(); await addFolder(); if (IS_APP) draw(); };
    const rs = d.querySelector("[data-rescan]");
    if (IS_APP) rs.onclick = async () => { await rescan(lib.folders); draw(); }; else rs.hidden = true;
  };
  draw();
  openModal(d);
}

/* ---------- Drag and drop ---------- */
/** Which playlist should a drop go to? The card under the pointer, else the playlist that is open. */
function dropTarget(x, y) {
  const hit = document.elementFromPoint(x, y);
  const card = hit && hit.closest("[data-pl]");
  if (card) return card.dataset.pl;
  return route.t === "playlist" ? route.id : null;
}
function initDrop() {
  const zone = $("#dropzone");
  const h2 = zone.querySelector("h2"), sub = zone.querySelector("p");
  let lastCard = null;
  const hint = (x, y) => {
    const id = dropTarget(x, y), p = id && store.playlists.find((q) => q.id === id);
    h2.textContent = p ? `Drop to add to “${p.name}”` : "Drop to add to your library";
    sub.textContent = p ? "The songs also join your library. Any number is fine." : "Songs, many songs at once, or whole folders";
    const card = document.elementFromPoint(x, y)?.closest(".pl-card");
    if (lastCard && lastCard !== card) lastCard.classList.remove("drop-on");
    if (card) card.classList.add("drop-on");
    lastCard = card;
  };
  const clear = () => { zone.hidden = true; if (lastCard) lastCard.classList.remove("drop-on"); lastCard = null; };
  if (IS_APP && TAURI.event) {
    // The desktop app hands over real file paths and where they were dropped (in device pixels).
    const at = (p) => [p.x / devicePixelRatio, p.y / devicePixelRatio];
    TAURI.event.listen("tauri://drag-enter", (e) => { zone.hidden = false; if (e.payload.position) hint(...at(e.payload.position)); });
    TAURI.event.listen("tauri://drag-over", (e) => { if (e.payload.position) hint(...at(e.payload.position)); });
    TAURI.event.listen("tauri://drag-leave", clear);
    TAURI.event.listen("tauri://drag-drop", (e) => {
      const target = e.payload.position ? dropTarget(...at(e.payload.position)) : route.t === "playlist" ? route.id : null;
      clear();
      addPaths(e.payload.paths, target);
    });
    return;
  }
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; zone.hidden = false; hint(e.clientX, e.clientY); });
  addEventListener("dragover", (e) => { e.preventDefault(); if (!zone.hidden) hint(e.clientX, e.clientY); });
  addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) clear(); });
  addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    const target = dropTarget(e.clientX, e.clientY);
    clear();
    if (!hasFiles(e)) return;
    // Entries must be read right now: the browser empties the drop data after this handler returns.
    const entries = [...e.dataTransfer.items].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
    pendingPlaylist = target;
    handleBrowserDrop(entries, [...e.dataTransfer.files]);
  });
}

/* ---------- Window controls (custom title bar) ---------- */
function initWindow() {
  if (!IS_APP || !TAURI.window) {
    for (const id of ["w-min", "w-max", "w-close"]) $("#" + id).hidden = true;
    return;
  }
  const win = TAURI.window.getCurrentWindow();
  const maxBtn = $("#w-max");
  const sync = async () => { maxBtn.innerHTML = icon((await win.isMaximized()) ? "restore" : "max"); };
  $("#w-min").onclick = () => win.minimize();
  maxBtn.onclick = () => win.toggleMaximize();
  $("#w-close").onclick = () => win.close();
  win.onResized(sync);
  sync();
}

/* ---------- Search ---------- */
function initSearch() {
  const input = $("#search");
  let timer = 0, returnRoute = null;
  const leave = () => {
    if (route.t !== "search") return;
    route = returnRoute || { t: "home" };
    render(); updateNav();
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const q = input.value.trim();
      if (q) {
        if (route.t !== "search") returnRoute = route;
        route = { t: "search", q };
        render(); updateNav();
      } else leave();
    }, 110);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { input.value = ""; input.blur(); leave(); }
    if (e.key === "Enter") input.blur();
  });
}

/* ---------- Keyboard ---------- */
function initKeys() {
  const typing = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeMenu(); if (!$("#modal").hidden) closeModal(); else closeNowPlaying(); }
    if (typing(e.target) || !$("#modal").hidden) return;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (k === " ") { e.preventDefault(); togglePlay(); }
    else if (k === "/" || (mod && k.toLowerCase() === "f")) { e.preventDefault(); $("#search").focus(); }
    else if (k === "Home") { e.preventDefault(); restartSong(); }
    else if (k === "ArrowRight") { e.preventDefault(); mod ? next(false) : seekTo(audio.currentTime + 5); }
    else if (k === "ArrowLeft") { e.preventDefault(); mod ? prev() : seekTo(audio.currentTime - 5); }
    else if (k === "ArrowUp") { e.preventDefault(); setVolume(store.vol + 0.05); }
    else if (k === "ArrowDown") { e.preventDefault(); setVolume(store.vol - 0.05); }
    else if (k.toLowerCase() === "m" && !mod) toggleMute();
    else if (k.toLowerCase() === "l" && !mod) { const s = curSong(); if (s) toggleLike(s.id); }
    else if (k.toLowerCase() === "s" && !mod) setShuffle(!store.shuffle);
    else if (k.toLowerCase() === "r" && !mod) cycleRepeat();
    else if (k.toLowerCase() === "q" && !mod) toggleQueue();
    else if (k.toLowerCase() === "f" && !mod) { $("#nowplaying").hidden ? openNowPlaying() : closeNowPlaying(); }
  });
  // Space on a focused button would also "click" it; Space is reserved for play/pause.
  addEventListener("keyup", (e) => { if (e.key === " " && !typing(e.target)) e.preventDefault(); });
  addEventListener("contextmenu", (e) => { if (!typing(e.target)) e.preventDefault(); });
}

/* ---------- Start ---------- */
async function boot() {
  await loadStore();
  initPlayer();
  initWindow();
  initSearch();
  initKeys();
  initDrop();

  for (const b of document.querySelectorAll(".tab[data-view]")) b.onclick = () => go({ t: b.dataset.view });
  $("#manage-folders").onclick = manageFolders;
  $("#add-music").onclick = openAddMenu;

  if (IS_APP && TAURI.event) {
    TAURI.event.listen("scan-progress", (e) => {
      const { done, total } = e.payload;
      $("#scan-text").textContent = total ? `Reading ${done.toLocaleString()} of ${total.toLocaleString()} songs` : "Up to date";
      $("#scan-fill").style.width = total ? (done / total) * 100 + "%" : "100%";
    });
  }

  let data = { folders: [], songs: [], covers_dir: "" };
  try { data = await invoke("load_library"); } catch (e) { console.error(e); }
  lib.coversDir = data.covers_dir;
  lib.sep = data.covers_dir.includes("\\") ? "\\" : "/";
  lib.folders = data.folders;
  lib.files = data.files || [];
  lib.isDemo = !IS_APP;
  buildIndex(data.songs);
  if (IS_APP) invoke("set_close_to_tray", { on: store.tray !== false }).catch(() => {});
  updateCounts();
  renderPlaylistNav();
  go({ t: "home" }, false);
  restoreLast();
  renderNowPlaying();
  document.body.classList.add("ready");

  // Pick up new or changed files quietly in the background.
  if (IS_APP && (lib.folders.length || lib.files.length)) setTimeout(() => rescan(lib.folders, { silent: true }), 600);
}
boot();
