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
/* Earphone sound: a wider stage, a little room around the music, fuller bass and clearer top. */
const EAR_PRESETS = {
  natural: { name: "Natural", width: 1.15, room: 0.1, bass: 1.5, clar: 1 },
  wide: { name: "Wide stage", width: 1.5, room: 0.18, bass: 2, clar: 1.5 },
  concert: { name: "Concert", width: 1.8, room: 0.32, bass: 3, clar: 2 },
};
const fxCfg = () => (store.fx = Object.assign({ eq: false, preset: "flat", bands: EQ_PRESETS.flat.g.slice(), level: false, xfade: 0, ear: true, earPreset: "natural", ...EAR_PRESETS.natural }, store.fx));

const FX = { ctx: null, bus: null, filters: [], comp: null, master: null, el: new Map(), xfading: false, timer: 0, silent: 0, m: null };
// The sound graph is always on now: the little waves follow the music through it, and it carries the equalizer too.
const fxNeeded = () => !store.fxBroken;
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
    // Earphone sound: bass and clarity shelves, then a stereo widener, then an optional room.
    const E = (FX.ear = {});
    E.bass = ctx.createBiquadFilter(); E.bass.type = "lowshelf"; E.bass.frequency.value = 110;
    E.clar = ctx.createBiquadFilter(); E.clar.type = "highshelf"; E.clar.frequency.value = 7500;
    node.connect(E.bass); E.bass.connect(E.clar);
    const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const mid = g(1), side = g(1), sideInv = g(-1), mL = g(0.5), mR = g(0.5), sL = g(0.5), sR = g(-0.5);
    E.clar.connect(split);
    split.connect(mL, 0); split.connect(mR, 1); split.connect(sL, 0); split.connect(sR, 1);
    mL.connect(mid); mR.connect(mid); sL.connect(side); sR.connect(side); side.connect(sideInv);
    mid.connect(merge, 0, 0); mid.connect(merge, 0, 1); side.connect(merge, 0, 0); sideInv.connect(merge, 0, 1);
    E.side = side; E.out = g(1); E.wet = g(0);
    merge.connect(E.out);
    // The room: a short, soft echo made of fading noise, kept dark so it never sounds hissy.
    const len = Math.floor(ctx.sampleRate * 1.2), imp = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = imp.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
    E.conv = ctx.createConvolver(); E.conv.buffer = imp;
    E.dark = ctx.createBiquadFilter(); E.dark.type = "lowpass"; E.dark.frequency.value = 5200;
    E.merge = merge; E.wetOn = false;
    E.out.connect(FX.comp);
    FX.comp.connect(FX.master);
    FX.master.connect(ctx.destination);
    for (const a of [audio, audio2]) {
      const src = ctx.createMediaElementSource(a);
      const level = ctx.createGain(), fade = ctx.createGain(), an = ctx.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0.35; // quick, so the waves hit on the beat
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
  const E = FX.ear;
  if (E) {
    const on = c.ear !== false, room = on ? c.room : 0;
    E.bass.gain.setTargetAtTime(on ? c.bass : 0, t, 0.05);
    E.clar.gain.setTargetAtTime(on ? c.clar : 0, t, 0.05);
    E.side.gain.setTargetAtTime(on ? c.width : 1, t, 0.05);
    // Keep some headroom, so a fuller sound never crackles.
    E.out.gain.setTargetAtTime(dbToLin(on ? -(c.bass * 0.55 + c.clar * 0.35 + room * 5 + Math.max(0, c.width - 1) * 1.2) : 0), t, 0.05);
    E.wet.gain.setTargetAtTime(room * 1.1, t, 0.05);
    if (room > 0.005 && !E.wetOn) { E.merge.connect(E.conv); E.conv.connect(E.dark); E.dark.connect(E.wet); E.wet.connect(FX.comp); E.wetOn = true; }
    else if (room <= 0.005 && E.wetOn) setTimeout(() => { if (fxCfg().ear === false || fxCfg().room <= 0.005) { try { E.merge.disconnect(E.conv); E.conv.disconnect(); E.dark.disconnect(); E.wet.disconnect(); E.wetOn = false; } catch (_) {} } }, 400);
  }
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
  waveStart();
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
  const earChips = Object.entries(EAR_PRESETS).map(([k, p]) => `<button class="chip${c.earPreset === k ? " on" : ""}" data-ear-preset="${k}">${p.name}</button>`).join("");
  const bands = EQ_FREQS.map((f, i) => `<label class="band"><span class="db" data-db="${i}"></span><input type="range" class="vrange" min="-12" max="12" step="0.5" value="${c.bands[i] || 0}" data-band="${i}" aria-label="${f} Hz"><span class="hz">${f >= 1000 ? f / 1000 + "k" : f}</span></label>`).join("");
  d.innerHTML = `
    <h3>Sound</h3>
    <label class="switch-row"><span>Earphone sound<small>A wider stage, a little room around the music, fuller bass and clearer top. Best with earphones or headphones.</small></span><input type="checkbox" class="switch" data-ear ${c.ear !== false ? "checked" : ""}></label>
    <div class="eq-box ear-box ${c.ear !== false ? "" : "off"}"><div class="chips">${earChips}</div>
      <div class="ear-sliders">
        <label>Width<input type="range" class="range" min="0.6" max="2" step="0.05" value="${c.width}" data-ear-k="width"><b data-ev="width"></b></label>
        <label>Room<input type="range" class="range" min="0" max="0.5" step="0.02" value="${c.room}" data-ear-k="room"><b data-ev="room"></b></label>
        <label>Bass<input type="range" class="range" min="0" max="6" step="0.5" value="${c.bass}" data-ear-k="bass"><b data-ev="bass"></b></label>
        <label>Clarity<input type="range" class="range" min="0" max="5" step="0.5" value="${c.clar}" data-ear-k="clar"><b data-ev="clar"></b></label>
      </div></div>
    <label class="switch-row"><span>Volume leveling<small>Quiet songs get turned up, loud ones turned down, so you don’t reach for the volume. Pulse learns each song the first time it plays.</small></span><input type="checkbox" class="switch" data-level ${c.level ? "checked" : ""}></label>
    <label class="switch-row"><span>Equalizer<small>Shape the sound with presets or the sliders.</small></span><input type="checkbox" class="switch" data-eq ${c.eq ? "checked" : ""}></label>
    <div class="eq-box ${c.eq ? "" : "off"}"><div class="chips">${presets}</div><div class="bands">${bands}</div></div>
    <div class="switch-row xf"><span>Crossfade<small>The end of a song blends into the next one.</small></span><div class="xf-ctl"><input type="range" class="range" min="0" max="12" step="1" value="${c.xfade}" data-xf aria-label="Crossfade seconds"><b data-xfv></b></div></div>
    <div class="actions"><button class="btn primary" data-x>Done</button></div>`;
  openModal(d);
  const showDb = () => d.querySelectorAll("[data-db]").forEach((s) => { const v = +fxCfg().bands[+s.dataset.db] || 0; s.textContent = (v > 0 ? "+" : "") + v; });
  const showXf = () => { const v = fxCfg().xfade; d.querySelector("[data-xfv]").textContent = v ? v + " s" : "Off"; d.querySelector("[data-xf]").style.setProperty("--p", (v / 12) * 100 + "%"); };
  showDb(); showXf();
  const EAR_RANGE = { width: [0.6, 2], room: [0, 0.5], bass: [0, 6], clar: [0, 5] };
  const showEar = () => d.querySelectorAll("[data-ear-k]").forEach((r) => {
    const k = r.dataset.earK, v = +fxCfg()[k], [lo, hi] = EAR_RANGE[k];
    r.value = v; r.style.setProperty("--p", ((v - lo) / (hi - lo)) * 100 + "%");
    d.querySelector(`[data-ev="${k}"]`).textContent = k === "width" ? Math.round(v * 100) + "%" : k === "room" ? Math.round(v * 200) + "%" : "+" + v;
  });
  showEar();
  d.querySelector("[data-ear]").onchange = (e) => { setFx({ ear: e.target.checked }); d.querySelector(".ear-box").classList.toggle("off", !e.target.checked); };
  d.querySelectorAll("[data-ear-preset]").forEach((b) => (b.onclick = () => {
    const k = b.dataset.earPreset;
    setFx({ ear: true, earPreset: k, ...EAR_PRESETS[k] });
    d.querySelector("[data-ear]").checked = true; d.querySelector(".ear-box").classList.remove("off");
    d.querySelectorAll("[data-ear-preset]").forEach((x) => x.classList.toggle("on", x === b));
    showEar();
  }));
  d.querySelectorAll("[data-ear-k]").forEach((r) => (r.oninput = () => {
    setFx({ ear: true, earPreset: "custom", [r.dataset.earK]: +r.value });
    d.querySelector("[data-ear]").checked = true; d.querySelector(".ear-box").classList.remove("off");
    d.querySelectorAll("[data-ear-preset]").forEach((x) => x.classList.remove("on"));
    showEar();
  }));
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

/* ---------- Waves that move with the music ---------- */
const BEAT_SEL = ".st-cover, .ly-cover, .npv-cover";
const WV = { avg: 0, beat: 0, raf: 0, last: 0, data: null, lv: new Array(7).fill(0), peak: 0.35, flat: 0 };
function waveStart() {
  if (WV.raf || !FX.ctx || document.hidden) return;
  WV.raf = requestAnimationFrame(waveFrame);
}
function waveStop() {
  WV.raf = 0;
  document.body.classList.remove("live-wave");
  for (const i of document.querySelectorAll(".np-wave i, .eq i")) i.style.transform = "";
  for (const e of document.querySelectorAll(BEAT_SEL)) e.style.setProperty("--beat", 0);
}
function waveFrame(t) {
  WV.raf = 0;
  const e = FX.ctx && FX.el.get(audio);
  if (!e || audio.paused || document.hidden) return waveStop();
  WV.raf = requestAnimationFrame(waveFrame);
  if (t - WV.last < 30) return; // about 30 pictures a second is plenty and keeps a slow PC cool
  WV.last = t;
  if (!WV.data || WV.data.length !== e.an.frequencyBinCount) WV.data = new Uint8Array(e.an.frequencyBinCount);
  e.an.getByteFrequencyData(WV.data);
  const bin = FX.ctx.sampleRate / e.an.fftSize; // Hz per bar of data
  // 7 slices from deep bass to treble, spaced like the ear hears them.
  const edges = [35, 80, 160, 320, 700, 1600, 3600, 9000];
  let loudest = 0;
  const raw = [];
  for (let b = 0; b < 7; b++) {
    const a = Math.max(1, Math.floor(edges[b] / bin)), z = Math.max(a + 1, Math.floor(edges[b + 1] / bin));
    let sum = 0;
    for (let k = a; k < z; k++) sum += WV.data[k];
    const v = sum / (z - a) / 255;
    raw.push(v);
    if (v > loudest) loudest = v;
  }
  if (loudest < 0.004) { if (++WV.flat > 90) { document.body.classList.remove("live-wave"); } return; } // no data: the CSS animation carries on
  WV.flat = 0;
  document.body.classList.add("live-wave");
  // Adapt to how loud this song is, so quiet songs still move and loud ones don't just sit at the top.
  WV.peak = Math.max(0.3, loudest, WV.peak * 0.992);
  for (let b = 0; b < 7; b++) {
    const target = Math.min(1, Math.pow(raw[b] / WV.peak, 1.6) * 1.05);
    const cur = WV.lv[b];
    WV.lv[b] = target > cur ? cur + (target - cur) * 0.75 : cur + (target - cur) * 0.22; // jumps up fast, falls gently
  }
  // Beat: how far the deep bass jumps above its own recent average (a kick drum), plus a little of the bass itself.
  const bassNow = Math.max(WV.lv[0], WV.lv[1] * 0.9);
  WV.avg += (bassNow - WV.avg) * 0.08;
  const kick = Math.max(0, bassNow - WV.avg * 1.1) * 3.2;
  const want = Math.min(1, kick + bassNow * 0.35);
  WV.beat += (want - WV.beat) * (want > WV.beat ? 0.8 : 0.16);
  if (store.beat !== false) {
    const bt = document.querySelectorAll(BEAT_SEL);
    for (let i = 0; i < bt.length; i++) bt[i].style.setProperty("--beat", WV.beat.toFixed(3));
  }
  if (playingView && playingView.feed) playingView.feed(WV.data, bin, WV.beat);
  const np = document.querySelectorAll(".np-wave i");
  for (let i = 0; i < np.length; i++) np[i].style.transform = `scaleY(${(0.14 + WV.lv[i] * 0.86).toFixed(3)})`;
  const eq = document.querySelectorAll(".row.playing .eq i, .npv .eq i");
  const map = [0, 2, 3, 4, 6];
  for (let i = 0; i < eq.length; i++) eq[i].style.transform = `scaleY(${(0.25 + WV.lv[map[i % 5]] * 0.75).toFixed(3)})`;
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) waveStart(); });
