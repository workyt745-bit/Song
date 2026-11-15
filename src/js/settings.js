/* Settings: your own accent color, and backup / restore of your playlists, likes and stats. */
"use strict";

const ACCENTS = ["#a99cff", "#ff7a93", "#ffb454", "#9be564", "#3dd9c1", "#4cc2ff", "#c77dff", "#ff6bd6"];
const isHex = (h) => /^#[0-9a-f]{6}$/i.test(h || "");

function chooseAccent(hex) {
  if (hex) store.accent = hex; else delete store.accent;
  saveStore();
  const s = curSong();
  setAccent(s && s.color);
  if (typeof emitMini === "function") emitMini();
}

/* ---------- Backup ---------- */
function makeBackup() {
  const L = store.listen || {};
  const ids = new Set([...(store.likes || []), ...Object.keys(store.plays || {}), ...(store.recent || []), ...(store.hidden || []), ...Object.keys(store.lastPlayed || {}), ...Object.keys(L.songs || {}), ...(store.playlists || []).flatMap((p) => p.ids)]);
  const all = new Map((lib.all || lib.songs).map((s) => [s.id, s]));
  const songs = {};
  for (const id of ids) { const s = all.get(id); if (s) songs[id] = { t: s.title, a: s.artist, d: Math.round(s.duration), p: s.path }; }
  const { gains, fxBroken, last, ...keep } = store;
  return { app: "pulse", v: 1, at: new Date().toISOString(), store: keep, songs };
}

async function exportBackup() {
  const json = JSON.stringify(makeBackup());
  try {
    if (IS_APP) {
      const name = await invoke("export_backup", { content: json });
      if (name) toast("Backup saved: " + name);
    } else {
      const a = el("a");
      a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      a.download = "pulse-backup.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast("Backup saved");
    }
  } catch (e) { toast("Couldn’t save the backup."); }
}

async function importBackup() {
  let text = null;
  try {
    if (IS_APP) text = await invoke("import_backup");
    else text = await new Promise((ok) => {
      const i = el("input"); i.type = "file"; i.accept = ".json,application/json";
      i.onchange = () => (i.files[0] ? i.files[0].text().then(ok) : ok(null));
      i.click();
    });
  } catch (e) { return toast(String(e).slice(0, 90) || "Couldn’t open that file."); }
  if (!text) return;
  let b;
  try { b = JSON.parse(text); } catch (_) { return toast("That file isn’t a Pulse backup."); }
  if (!b || b.app !== "pulse" || !b.store) return toast("That file isn’t a Pulse backup.");

  // Songs keep their id when they sit in the same place. On a new PC the paths differ, so match by path, then by name + artist.
  const all = lib.all || lib.songs, norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const byId = new Map(all.map((s) => [s.id, s]));
  const byPath = new Map(all.map((s) => [String(s.path).toLowerCase(), s]));
  const byName = new Map();
  for (const s of all) byName.set(norm(s.title) + "|" + norm(s.artist), s);
  let found = 0, lost = 0;
  const memo = new Map();
  const map = (id) => {
    if (memo.has(id)) return memo.get(id);
    let to = null;
    if (byId.has(id)) to = id;
    else {
      const i = (b.songs || {})[id];
      const s = i && (byPath.get(String(i.p).toLowerCase()) || byName.get(norm(i.t) + "|" + norm(i.a)));
      if (s) to = s.id;
    }
    memo.set(id, to);
    to ? found++ : lost++;
    return to;
  };
  const ids = (a) => [...new Set((a || []).map(map).filter(Boolean))];
  const idsKeep = (a) => (a || []).map(map).filter(Boolean); // playlists may repeat a song
  const obj = (o, merge) => { const r = {}; for (const [k, v] of Object.entries(o || {})) { const n = map(k); if (n) r[n] = merge && r[n] ? r[n] + v : v; } return r; };

  const S = b.store, next = { ...S };
  next.likes = ids(S.likes);
  next.hidden = ids(S.hidden);
  next.recent = ids(S.recent);
  next.playlists = (S.playlists || []).map((p) => ({ ...p, ids: idsKeep(p.ids) }));
  next.plays = obj(S.plays, true);
  next.lastPlayed = obj(S.lastPlayed);
  next.listen = { ...(S.listen || { total: 0, days: {} }), songs: obj((S.listen || {}).songs, true) };
  const nPl = next.playlists.length;

  confirmModal("Restore this backup?", `It brings back ${plural(nPl, "playlist")}, ${plural(next.likes.length, "liked song")}, your play counts and settings. ${lost ? plural(lost, "song") + " in it can’t be found on this PC and will be left out. " : ""}It replaces what Pulse has now.`, "Restore", async () => {
    noSave = true;
    clearTimeout(saveTimer);
    try {
      const json = JSON.stringify({ ...store, ...next });
      if (IS_APP) await invoke("save_store", { json }); else localStorage.setItem("pulse-store", json);
    } catch (_) {}
    location.reload();
  });
}

/* ---------- The dialog ---------- */
function openSettings() {
  const d = el("div", "dialog settings");
  const draw = () => {
    const cur = isHex(store.accent) ? store.accent.toLowerCase() : "";
    d.innerHTML = `<h3>Settings</h3>
      <div class="set-h">Color</div>
      <p class="note" style="margin-bottom:10px">Pulse colors itself from the album cover. Or pick one color to keep.</p>
      <div class="swatches">
        <button class="sw auto${cur ? "" : " on"}" data-c="">Follow the album</button>
        ${ACCENTS.map((c) => `<button class="sw${cur === c ? " on" : ""}" style="--c:${c}" data-c="${c}" aria-label="Color ${c}"></button>`).join("")}
        <label class="sw custom${cur && !ACCENTS.includes(cur) ? " on" : ""}" style="--c:${cur || "#fff"}" title="Choose any color"><input type="color" value="${cur || "#a99cff"}" data-custom></label>
      </div>
      <div class="set-h">Backup</div>
      <p class="note" style="margin-bottom:10px">Save your playlists, likes, play counts and settings in one file, and bring them back any time, even on another PC. Your music files are not inside it.</p>
      <div class="btn-row" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-export>Save a backup</button><button class="btn" data-import>Restore a backup</button></div>
      <div class="actions"><button class="btn primary" data-x>Done</button></div>`;
    d.querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => { chooseAccent(b.dataset.c); draw(); }));
    const ci = d.querySelector("[data-custom]");
    ci.oninput = () => chooseAccent(ci.value);
    ci.onchange = () => draw();
    d.querySelector("[data-export]").onclick = exportBackup;
    d.querySelector("[data-import]").onclick = () => { closeModal(); importBackup(); };
    d.querySelector("[data-x]").onclick = closeModal;
  };
  draw();
  openModal(d);
}
