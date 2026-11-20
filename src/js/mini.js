/* The mini player window. It only shows what the main window tells it, and sends button presses back. */
"use strict";
const T = window.__TAURI__;
const $ = (s) => document.querySelector(s);
let st = null, at = 0;

function paint() {
  if (!st) return;
  $("#title").textContent = st.title || "Nothing playing";
  $("#artist").textContent = st.artist || "Open Pulse and pick a song";
  const img = $("#cover img");
  if (st.cover) { if (img.getAttribute("src") !== st.cover) img.src = st.cover; img.hidden = false; img.onerror = () => (img.hidden = true); } else img.hidden = true;
  if (st.color) document.documentElement.style.setProperty("--accent", st.color);
  $("#pl").style.display = st.playing ? "none" : "";
  $("#pa").style.display = st.playing ? "" : "none";
  $("#toggle").setAttribute("aria-label", st.playing ? "Pause" : "Play");
  document.title = st.title ? st.title + " · Pulse" : "Pulse";
}
function bar() {
  if (!st || !st.dur) return $("#prog i").style.width = "0";
  const pos = st.pos + (st.playing ? (Date.now() - at) / 1000 : 0);
  $("#prog i").style.width = Math.min(100, (pos / st.dur) * 100) + "%";
}
if (T && T.event) {
  T.event.listen("mini-state", (e) => { st = e.payload; at = Date.now(); paint(); bar(); });
  setInterval(bar, 250);
  const send = (a) => T.event.emit("thumb-action", a);
  $("#prev").onclick = () => send("prev");
  $("#next").onclick = () => send("next");
  $("#toggle").onclick = () => send("toggle");
  $("#expand").onclick = () => { T.event.emit("mini-closed"); T.core.invoke("close_mini"); };
  T.event.emit("mini-ready");
} else {
  $("#artist").textContent = "Works inside the Pulse app";
}
