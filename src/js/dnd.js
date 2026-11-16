/* Dragging songs inside the app: drop them on a playlist, or re-order a playlist.
   Done with the mouse directly (not the browser's drag feature, which the desktop window turns off
   so that files can be dropped in from Explorer). */
"use strict";

(function () {
  const DIST = 6;
  let st = null, ghost = null, tray = null, line = null, scrollV = 0, scrollTimer = 0, swallow = false;

  addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    const row = e.target.closest(".songs .row");
    if (!row || e.target.closest("button,.link")) return;
    const host = row.closest(".songs");
    if (!host || !host._dnd) return;
    st = { host, d: host._dnd, row, x: e.clientX, y: e.clientY, on: false, ids: [], overChip: null, insert: null };
  }, true);

  addEventListener("pointermove", (e) => {
    if (!st) return;
    if (!st.on) {
      if (Math.hypot(e.clientX - st.x, e.clientY - st.y) < DIST) return;
      begin();
    }
    move(e);
  });
  addEventListener("pointerup", (e) => { if (st && st.on) finish(e); st = null; });
  addEventListener("pointercancel", () => { cancel(); });
  addEventListener("blur", () => { cancel(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && st && st.on) { cancel(); e.stopPropagation(); } }, true);
  addEventListener("click", (e) => { if (swallow) { e.stopPropagation(); e.preventDefault(); swallow = false; } }, true);

  function begin() {
    const { d, row } = st;
    const i = row._i;
    if (!d.sel.has(i)) { d.sel.clear(); d.sel.add(i); d.vl.rebind(); }
    const idx = [...d.sel].sort((a, b) => a - b);
    st.songs = idx.map((k) => d.songs[k]);
    st.ids = st.songs.map((s) => s.id);
    st.on = true;
    document.body.classList.add("dragging");
    ghost = el("div", "drag-ghost");
    const cv = coverEl("s40");
    setCover(cv, st.songs[0].cover, st.songs[0].album);
    ghost.append(cv, el("span", "", esc(st.songs.length > 1 ? plural(st.songs.length, "song") : st.songs[0].title)));
    document.body.appendChild(ghost);
    // A row of playlists to drop on.
    tray = el("div", "drag-tray");
    tray.appendChild(el("span", "dt-label", "Drop on a playlist"));
    for (const p of store.playlists) {
      if (p.id === d.opts.playlistId) continue;
      const c = el("div", "dt-chip", `${icon("list")}<span>${esc(p.name)}</span>`);
      c.dataset.pl = p.id;
      tray.appendChild(c);
    }
    const nc = el("div", "dt-chip new", `${icon("plus")}<span>New playlist</span>`);
    nc.dataset.new = "1";
    tray.appendChild(nc);
    document.body.appendChild(tray);
    if (d.opts.playlistId) {
      line = el("div", "drop-line");
      line.hidden = true;
      st.host.appendChild(line);
    }
  }

  function move(e) {
    ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 12}px)`;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const chip = under && under.closest(".dt-chip");
    for (const c of tray.querySelectorAll(".dt-chip.over")) if (c !== chip) c.classList.remove("over");
    if (chip) chip.classList.add("over");
    st.overChip = chip;
    // Re-ordering inside a playlist.
    st.insert = null;
    if (line) {
      const sc = st.host.closest(".scroller"), r = sc.getBoundingClientRect();
      const inside = !chip && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (inside) {
        const hr = st.host.getBoundingClientRect();
        st.insert = Math.max(0, Math.min(st.d.songs.length, Math.round((e.clientY - hr.top) / st.d.h)));
        line.style.top = st.insert * st.d.h - 1 + "px";
        line.hidden = false;
      } else line.hidden = true;
      // Scroll the list when the pointer is near its top or bottom edge.
      const edge = 70;
      scrollV = e.clientY < r.top + edge ? -(1 - (e.clientY - r.top) / edge) * 18 : e.clientY > r.bottom - edge ? (1 - (r.bottom - e.clientY) / edge) * 18 : 0;
      if (scrollV && !scrollTimer) scrollTimer = setInterval(() => { sc.scrollTop += scrollV; }, 16);
      if (!scrollV && scrollTimer) { clearInterval(scrollTimer); scrollTimer = 0; }
    }
  }

  function finish() {
    const { overChip, insert, ids, d } = st;
    cleanup();
    swallow = true;
    setTimeout(() => (swallow = false), 0);
    if (overChip) {
      if (overChip.dataset.new) promptName("New playlist", "", (n) => { const p = createPlaylist(n); addToPlaylist(p.id, ids); });
      else addToPlaylist(overChip.dataset.pl, ids);
    } else if (insert != null && d.opts.playlistId) {
      movePlaylistSongs(d.opts.playlistId, ids, insert);
    }
  }
  function cancel() { if (st && st.on) cleanup(); st = null; }
  function cleanup() {
    clearInterval(scrollTimer); scrollTimer = 0;
    document.body.classList.remove("dragging");
    for (const n of [ghost, tray, line]) n && n.remove();
    ghost = tray = line = null;
    if (st) st.on = false;
  }
})();
