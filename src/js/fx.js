/* Sound: equalizer, volume leveling and crossfade.
   Nothing here is switched on until you ask for it. While everything is off Pulse plays the
   song straight from the file and uses no extra memory or processor time. */
"use strict";

const EQ_FREQS = [60, 170, 400, 1000, 2400, 6000, 10000, 15000];
const EQ_PRESETS = {
  flat: { name: "Flat", g: [0, 0, 0, 0, 0, 0, 0, 0] },
  bass: { name: "Bass boost", g: [6, 5, 3, 0, 0, 0, 0, 0] },
  vocal: { name: "Vocal", g: [-2, -1, 0, 3, 4, 3, 0, -1] },
  treble: { name: "Treble boost", g: [0, 0, 0, 0, 1, 3, 5, 6] },
  rock: { name: "Rock", g: [4, 3, -1, -2, 0, 2, 4, 4] },
  pop: { name: "Pop", g: [-1, 2, 4, 3, 0, -1, -1, -2] },
  dance: { name: "Dance", g: [5, 4, 0, -2, 0, 2, 4, 5] },
  acoustic: { name: "Acoustic", g: [3, 2, 1, 1, 2, 2, 3, 2] },
};
const LEVEL_TARGET_DB = -14; // average loudness every song is nudged towards
const fxCfg = () => (store.fx = Object.assign({ eq: false, preset: "flat", bands: EQ_PRESETS.flat.g.slice(), level: false, xfade: 0 }, store.fx));

const FX = { ctx: null, bus: null, filters: [], comp: null, master: null, el: new Map(), xfading: false, timer: 0, silent: 0, m: null };
const fxNeeded = () => { const c = fxCfg(); return c.eq || c.level || c.xfade > 0; };
const dbToLin = (db) => Math.pow(10, db / 20);

/** Builds the sound graph once. Both players (the second is only used for crossfade) go through it. */
function fxInit() {
  if (FX.ctx) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  try {
    for (const a of [audio, audio2]) a.crossOrigin = "anonymous";
    const ctx = (FX.ctx = new AC({ latencyHint: "playback" }));
    FX.bus = ctx.createGain();
    FX.filters = EQ_FREQS.map((f, i) => {
      const n = ctx.createBiquadFilter();
      n.type = i === 0 ? "lowshelf" : i === EQ_FREQS.length - 1 ? "highshelf" : "peaking";
      n.frequency.value = f;
      n.Q.value = 1;
      n.gain.value = 0;
      return n;
    });
    FX.comp = ctx.createDynamicsCompressor();
    FX.master = ctx.createGain();
    let node = FX.bus;
    for (const f of FX.filters) { node.connect(f); node = f; }
    node.connect(FX.comp);
    FX.comp.connect(FX.master);
    FX.master.connect(ctx.destination);
    for (const a of [audio, audio2]) {
      const src = ctx.createMediaElementSource(a);
      const level = ctx.createGain(), fade = ctx.createGain(), an = ctx.createAnalyser();
      an.fftSize = 2048;
      src.connect(level); level.connect(fade); fade.connect(FX.bus);
      src.connect(an); // measures the song before any change
      FX.el.set(a, { level, fade, an, buf: new Float32Array(an.fftSize) });
    }
    audio.volume = 1; audio2.volume = 1; // volume is now set on the master control
    fxApply();
    setVolume(store.vol);
    clearInterval(FX.timer);
    FX.timer = setInterval(fxTick, 250);
    return true;
  } catch (e) {
    console.warn("Sound effects unavailable", e);
    FX.ctx = null;
    return false;
  }
}
function fxResume() { if (FX.ctx && FX.ctx.state === "suspended") FX.ctx.resume().catch(() => {}); }
document.addEventListener("pointerdown", fxResume, true);
document.addEventListener("keydown", fxResume, true);

/** Pushes the saved settings into the graph. */
function fxApply() {
  if (!FX.ctx) return;
  const c = fxCfg(), t = FX.ctx.currentTime;
  FX.filters.forEach((f, i) => f.gain.setTargetAtTime(c.eq ? c.bands[i] || 0 : 0, t, 0.03));
  // The leveling uses a soft limiter so that boosted songs never crackle.
  FX.comp.threshold.value = c.level ? -6 : 0;
  FX.comp.knee.value = c.level ? 6 : 0;
  FX.comp.ratio.value = c.level ? 12 : 1;
  FX.comp.attack.value = 0.003;
  FX.comp.release.value = 0.25;
  const e = FX.el.get(audio);
  if (e) {
    const s = curSong();
    e.level.gain.setTargetAtTime(c.level && s && store.gains[s.id] != null ? dbToLin(store.gains[s.id]) : 1, t, 0.05);
  }
  if (!c.level && FX.m) FX.m = null;
}
store.gains = store.gains || {};

/** Called whenever a new song starts in the current player. */
function fxSongStarted(s) {
  FX.m = { id: s.id, sum: 0, n: 0, lastGain: null };
  FX.silent = 0;
  if (!FX.ctx) return;
  const e = FX.el.get(audio);
  if (!e) return;
  e.level.gain.cancelScheduledValues(0);
  const c = fxCfg();
  const g = c.level && store.gains[s.id] != null ? dbToLin(store.gains[s.id]) : 1;
  e.level.gain.setValueAtTime(g, FX.ctx.currentTime);
}

/** Every 0.25 seconds: measure loudness, start a crossfade, and watch that sound really comes out. */
function fxTick() {
  if (!FX.ctx || audio.paused) return;
  const c = fxCfg(), e = FX.el.get(audio), s = curSong();
  if (!e || !s) return;
  e.an.getFloatTimeDomainData(e.buf);
  let sum = 0, peak = 0;
  for (let i = 0; i < e.buf.length; i++) { const v = e.buf[i]; sum += v * v; if (Math.abs(v) > peak) peak = Math.abs(v); }
  const rms = Math.sqrt(sum / e.buf.length);

  // 1. Is any sound coming out at all? If not for a long while, the effects are switched off for good.
  if (peak === 0 && FX.ctx.state === "running" && store.vol > 0 && audio.currentTime > 1 && !FX.xfading) FX.silent += 0.25; else FX.silent = 0;
  if (FX.silent > 12) return fxGiveUp();

  // 2. Leveling: the average loudness of this song so far decides how much to turn it up or down.
  if (c.level && FX.m && FX.m.id === s.id && rms > 0.006) {
    FX.m.sum += rms * rms; FX.m.n++;
    if (FX.m.n >= 24 && FX.m.n % 8 === 0) {
      const avgDb = 10 * Math.log10(FX.m.sum / FX.m.n);
      const gain = clamp(LEVEL_TARGET_DB - avgDb, -10, 8);
      e.level.gain.cancelScheduledValues(FX.ctx.currentTime);
      e.level.gain.setTargetAtTime(dbToLin(gain), FX.ctx.currentTime, 1.2);
      FX.m.lastGain = gain;
      store.gains[s.id] = Math.round(gain * 10) / 10; // remembered, so next time it starts at the right level
      FX.dirty = true;
    }
  }
  if (FX.dirty && audio.currentTime > 40) { FX.dirty = false; saveStore(); }

  // 3. Crossfade: start the next song a few seconds before this one ends.
  const d = audio.duration;
  if (c.xfade > 0 && !FX.xfading && !P.seeking && isFinite(d) && d > c.xfade * 2 + 6) {
    const left = d - audio.currentTime;
    if (left <= c.xfade && left > 0.4) fxCrossfade(c.xfade);
  }
}
function fxGiveUp() {
  store.fx = { eq: false, preset: "flat", bands: EQ_PRESETS.flat.g.slice(), level: false, xfade: 0 };
  store.fxBroken = true;
  saveStore();
  toast("Sound effects don’t work on this PC, so they were turned off.");
  setTimeout(() => location.reload(), 1600);
}

/** The index of the song that plays after this one, or -1 when there is none to blend into. */
function peekNextIndex() {
  if (!P.list.length || store.repeat === 2) return -1;
  return P.i + 1 < P.list.length ? P.i + 1 : -1;
}
function fxCrossfade(sec) {
  const ni = peekNextIndex();
  const s = ni >= 0 ? lib.byId.get(P.list[ni]) : null;
  if (!s || (!IS_APP && s._file)) return; // files opened in the browser preview can’t be blended
  const out = audio, inn = audio2, eo = FX.el.get(out), ei = FX.el.get(inn);
  if (!eo || !ei) return;
  FX.xfading = true;
  const t = FX.ctx.currentTime;
  const up = new Float32Array(64), down = new Float32Array(64);
  for (let i = 0; i < 64; i++) { const x = i / 63; up[i] = Math.sin(x * Math.PI / 2); down[i] = Math.cos(x * Math.PI / 2); }
  for (const g of [eo.fade.gain, ei.fade.gain]) g.cancelScheduledValues(0);
  ei.fade.gain.setValueAtTime(0, t);
  ei.fade.gain.setValueCurveAtTime(up, t, sec);
  eo.fade.gain.setValueAtTime(1, t);
  eo.fade.gain.setValueCurveAtTime(down, t, sec);
  inn.src = srcOf(s);
  inn.currentTime = 0;
  // From here on the new song is "the" song: the queue moves on and the screen follows.
  audio = inn; audio2 = out;
  P.i = ni;
  loadCurrent(true, 0, { keep: true });
  followQueue();
  FX.fadeOut = out;
  clearTimeout(FX.endTimer);
  FX.endTimer = setTimeout(() => fxEndCrossfade(), sec * 1000 + 300);
}
function fxEndCrossfade() {
  const old = audio2;
  if (old) { old.pause(); old.removeAttribute("src"); old.load(); }
  const eo = old && FX.el.get(old);
  if (eo && FX.ctx) { eo.fade.gain.cancelScheduledValues(0); eo.fade.gain.setValueAtTime(1, FX.ctx.currentTime); }
  FX.xfading = false;
  FX.fadeOut = null;
}
/** Someone pressed next or picked another song in the middle of a blend. */
function fxAbortCrossfade() {
  if (!FX.xfading) return;
  clearTimeout(FX.endTimer);
  fxEndCrossfade();
}

/* ---------- The Sound dialog ---------- */
function setFx(patch) {
  const was = fxNeeded();
  if (patch.preset && EQ_PRESETS[patch.preset] && !patch.bands) patch = { ...patch, bands: EQ_PRESETS[patch.preset].g.slice() };
  Object.assign(fxCfg(), patch);
  saveStore();
  if (fxNeeded() && !FX.ctx && !store.fxBroken) {
    // First time effects are used: switch the player over to the sound graph (the song restarts at the same spot).
    const s = curSong(), pos = audio.currentTime, playing = isPlaying();
    if (fxInit() && s) loadCurrent(playing, pos);
  }
  fxApply();
  void was;
}
function openSound() {
  const c = fxCfg();
  const d = el("div", "dialog sound");
  const presets = Object.entries(EQ_PRESETS).map(([k, p]) => `<button class="chip${c.preset === k ? " on" : ""}" data-preset="${k}">${p.name}</button>`).join("");
  const bands = EQ_FREQS.map((f, i) => `<label class="band"><span class="db" data-db="${i}"></span><input type="range" class="vrange" min="-12" max="12" step="0.5" value="${c.bands[i] || 0}" data-band="${i}" aria-label="${f} Hz"><span class="hz">${f >= 1000 ? f / 1000 + "k" : f}</span></label>`).join("");
  d.innerHTML = `
    <h3>Sound</h3>
    <label class="switch-row"><span>Volume leveling<small>Quiet songs get turned up, loud ones turned down, so you don’t reach for the volume. Pulse learns each song the first time it plays.</small></span><input type="checkbox" class="switch" data-level ${c.level ? "checked" : ""}></label>
    <label class="switch-row"><span>Equalizer<small>Shape the sound with presets or the sliders.</small></span><input type="checkbox" class="switch" data-eq ${c.eq ? "checked" : ""}></label>
    <div class="eq-box ${c.eq ? "" : "off"}"><div class="chips">${presets}</div><div class="bands">${bands}</div></div>
    <div class="switch-row xf"><span>Crossfade<small>The end of a song blends into the next one.</small></span><div class="xf-ctl"><input type="range" class="range" min="0" max="12" step="1" value="${c.xfade}" data-xf aria-label="Crossfade seconds"><b data-xfv></b></div></div>
    <div class="actions"><button class="btn primary" data-x>Done</button></div>`;
  openModal(d);
  const showDb = () => d.querySelectorAll("[data-db]").forEach((s) => { const v = +fxCfg().bands[+s.dataset.db] || 0; s.textContent = (v > 0 ? "+" : "") + v; });
  const showXf = () => { const v = fxCfg().xfade; d.querySelector("[data-xfv]").textContent = v ? v + " s" : "Off"; d.querySelector("[data-xf]").style.setProperty("--p", (v / 12) * 100 + "%"); };
  showDb(); showXf();
  d.querySelector("[data-level]").onchange = (e) => { setFx({ level: e.target.checked }); };
  d.querySelector("[data-eq]").onchange = (e) => { setFx({ eq: e.target.checked }); d.querySelector(".eq-box").classList.toggle("off", !e.target.checked); };
  d.querySelectorAll("[data-preset]").forEach((b) => (b.onclick = () => {
    const k = b.dataset.preset;
    setFx({ preset: k, bands: EQ_PRESETS[k].g.slice(), eq: true });
    d.querySelector("[data-eq]").checked = true;
    d.querySelector(".eq-box").classList.remove("off");
    d.querySelectorAll("[data-band]").forEach((r) => (r.value = fxCfg().bands[+r.dataset.band]));
    d.querySelectorAll("[data-preset]").forEach((x) => x.classList.toggle("on", x === b));
    showDb();
  }));
  d.querySelectorAll("[data-band]").forEach((r) => (r.oninput = () => {
    const bands = fxCfg().bands.slice();
    bands[+r.dataset.band] = +r.value;
    setFx({ bands, preset: "custom", eq: true });
    d.querySelector("[data-eq]").checked = true;
    d.querySelector(".eq-box").classList.remove("off");
    d.querySelectorAll("[data-preset]").forEach((x) => x.classList.remove("on"));
    showDb();
  }));
  d.querySelector("[data-xf]").oninput = (e) => { setFx({ xfade: +e.target.value }); showXf(); };
  d.querySelector("[data-x]").onclick = closeModal;
}
