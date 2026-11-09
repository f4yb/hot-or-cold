"use strict";
/* =====================================================================
   HOT OR COLD ENGINE V4
     seeker phone  -> step counter + compass -> its own (x, y) -> server
     hider phone   -> tap on the map         -> (x, y)           -> server
     tracker       -> watches the map, drags dots to correct drift
     server (app.py) works out distance / bounds / found and sends
     { running, found, inBounds, d, trk, seeker:{x,y,heading,live}, hider:{x,y}, room:{w,h} } at 10 Hz.
   World coordinates are metres, (0,0) is the bottom-left corner,
   +y points at the top wall ("north"), heading 0 = facing the top wall.
   Everything tweakable lives in CONFIG and ZONES.
   ===================================================================== */

const CONFIG = {
  staleMs: 2500,           // treat the link as lost after this long with no state
  smoothing: 0.35,         // seeker-side distance smoothing (0..1, higher = snappier)
  mapMargin: 1,            // metres of space shown outside the play area on the map
  sendIntervalMs: 100,     // seeker position heartbeat (10 Hz)
  // Pedestrian dead reckoning (seeker phone). Tune on the real phone + walker.
  stepLength: 0.7,         // metres per step
  stepThresh: 1.2,         // m/s^2 above gravity that counts as a step peak
  stepMinMs: 350,          // ignore peaks closer together than this
  stepGlideS: 0.5,         // spread each step's movement over this long, so distance moves smoothly
  keyboardSpeed: 1.2       // m/s when testing the seeker on a laptop with the arrow keys / WASD
};

// Zone rings drawn on the map around the hider (hot, warm, cool, cold). "max" = ring radius in metres.
const ZONES = [
  { max: 1, color: "#ff4a2b" },
  { max: 2, color: "#ffa31a" },
  { max: 3, color: "#4fc3b0" },
  { max: 4, color: "#3d8bff" }
];

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const cleanCode = (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, "");
const isCode = (v) => /^[A-Z0-9]{4}$/.test(v || "");
const showJoinError = (box, input) => { $(box).textContent = "Enter the 4-character code from the laptop."; $(box).hidden = false; input.focus(); };

/* ---------- Wake lock: stop the screen sleeping mid-round ---------- */
async function keepAwake() {
  try { if ("wakeLock" in navigator) await navigator.wakeLock.request("screen"); } catch (e) {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    keepAwake();
    try { if (window.Tone && Tone.context.state !== "running") Tone.context.resume(); } catch (e) {}
  }
});

/* ---------- Server link (Socket.IO to app.py) ---------- */
let socket = null;
function connectServer(onConnect) {
  if (typeof io === "undefined") { alert("Socket.IO did not load. Check the internet connection."); return null; }
  socket = io({ reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 2000 });
  socket.on("connect", onConnect);    // also fires after every reconnect, so we re-join automatically
  return socket;
}

/* =====================================================================
   AUDIO: a generative backing track that never stops.
   Chord loop: Am - F - C - G (4 bars). Distance decides which LAYERS are in:
     far   : pad only (dark, muffled, lots of reverb)
     COLD  : + heartbeat kick, sparse arpeggio
     COOL  : + bass line, off-beat hi-hats
     WARM  : + clap, chord plucks, kick gets busier
     HOT   : + melody, strings
     FOUND : the full symphony (timpani roll, harmony line, sparkle, crash, fast tempo)
   Closer also means: brighter (filter opens), drier (less reverb), faster (tempo rises).
   ===================================================================== */
const sstep = (x) => { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); };
const band = (d, full, off) => sstep((off - d) / (off - full));   // 1 when d <= full, 0 when d >= off

const LAYERS = {
  pad:     (d) => 0.5 + 0.5 * band(d, 2.5, 6),
  heart:   (d) => band(d, 3.0, 4.2),
  arp:     (d) => band(d, 3.0, 4.2),
  bass:    (d) => band(d, 2.0, 3.2),
  hats:    (d) => band(d, 1.8, 3.0),
  clap:    (d) => band(d, 1.2, 2.2),
  stab:    (d) => band(d, 1.0, 2.0),
  lead:    (d) => band(d, 0.6, 1.3),
  strings: (d) => band(d, 0.4, 1.0)
};
const FOUND_GAINS = { pad: 1, heart: 1, arp: 1, bass: 1, hats: 1, clap: 1, stab: 1, lead: 1, strings: 1, timpani: 1, harmony: 1, sparkle: 1, crash: 1 };

const CHORDS = [
  { tones: ["A3", "C4", "E4", "A4"], pad: ["A3", "C4", "E4"], bass: ["A2", "E3"], str: ["A4", "C5", "E5"] },
  { tones: ["F3", "A3", "C4", "F4"], pad: ["F3", "A3", "C4"], bass: ["F2", "C3"], str: ["F4", "A4", "C5"] },
  { tones: ["C4", "E4", "G4", "C5"], pad: ["C4", "E4", "G4"], bass: ["C3", "G3"], str: ["G4", "C5", "E5"] },
  { tones: ["G3", "B3", "D4", "G4"], pad: ["G3", "B3", "D4"], bass: ["G2", "D3"], str: ["G4", "B4", "D5"] }
];
const MELODY = [
  ["A4", 0, 0, 0, "C5", 0, 0, 0, "E5", 0, 0, 0, "D5", 0, "C5", 0],
  ["C5", 0, 0, 0, "A4", 0, 0, 0, "F4", 0, 0, 0, "A4", 0, "C5", 0],
  ["E5", 0, 0, 0, "G5", 0, 0, 0, "E5", 0, 0, 0, "D5", 0, "C5", 0],
  ["D5", 0, 0, 0, "B4", 0, 0, 0, "G4", 0, 0, 0, "B4", 0, "D5", 0]
];
const BASS_PATTERN = { 0: 0, 6: 0, 8: 0, 11: 1, 14: 0 };
const STAB_STEPS = [3, 6, 10, 14];
const PENTA = ["C6", "D6", "E6", "G6", "A6", "C7"];

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const THIRD = { 0: 4, 2: 3, 4: 3, 5: 4, 7: 4, 9: 3, 11: 3 };
function thirdAbove(n) {
  const m = /^([A-G]#?)(\d)$/.exec(n); if (!m) return n;
  const pc = NOTE_NAMES.indexOf(m[1]);
  const midi = 12 * (parseInt(m[2], 10) + 1) + pc + (THIRD[pc] || 4);
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

const Score = {
  ready: false, cur: null, dS: null, wasFound: false, lastFire: 0, tickCount: 0, lastBpm: 0, inst: {},

  async init() {
    if (this.ready) return;
    if (typeof Tone === "undefined") throw new Error("Tone.js did not load. Check the internet connection.");
    await Tone.start();
    if (Tone.context.state !== "running") await Tone.context.resume();

    // master chain: instruments -> mix -> lowpass -> reverb -> compressor -> limiter -> out
    this.limiter = new Tone.Limiter(-2).toDestination();
    this.comp = new Tone.Compressor(-18, 3).connect(this.limiter);
    this.verb = new Tone.Freeverb({ roomSize: 0.8, dampening: 3000, wet: 0.4 }).connect(this.comp);
    this.filt = new Tone.Filter(900, "lowpass").connect(this.verb);
    this.mix = new Tone.Gain(0.8).connect(this.filt);

    const via = (node, filterType, freq) => { const f = new Tone.Filter(freq, filterType); node.connect(f); f.connect(this.mix); return node; };
    const I = this.inst;
    I.pad = new Tone.PolySynth(Tone.Synth, { oscillator: { type: "fatsawtooth", count: 3, spread: 25 }, envelope: { attack: 1.0, decay: 0.4, sustain: 0.8, release: 2.0 } });
    via(I.pad, "lowpass", 2200); I.pad.volume.value = -17;
    I.heart = new Tone.MembraneSynth({ pitchDecay: 0.04, octaves: 5, envelope: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.1 } });
    I.heart.connect(this.mix); I.heart.volume.value = -7;
    I.arp = new Tone.PolySynth(Tone.Synth, { oscillator: { type: "triangle" }, envelope: { attack: 0.005, decay: 0.25, sustain: 0, release: 0.3 } });
    I.arp.connect(this.mix); I.arp.volume.value = -13;
    I.bass = new Tone.Synth({ oscillator: { type: "triangle" }, envelope: { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.15 } });
    I.bass.connect(this.mix); I.bass.volume.value = -8;
    I.hats = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.05, sustain: 0 } });
    via(I.hats, "highpass", 7000); I.hats.volume.value = -22;
    I.clap = new Tone.NoiseSynth({ noise: { type: "pink" }, envelope: { attack: 0.001, decay: 0.15, sustain: 0 } });
    via(I.clap, "bandpass", 1800); I.clap.volume.value = -12;
    I.stab = new Tone.PolySynth(Tone.Synth, { oscillator: { type: "triangle" }, envelope: { attack: 0.005, decay: 0.15, sustain: 0, release: 0.2 } });
    I.stab.connect(this.mix); I.stab.volume.value = -15;
    I.lead = new Tone.Synth({ oscillator: { type: "sawtooth" }, envelope: { attack: 0.02, decay: 0.2, sustain: 0.5, release: 0.4 } });
    via(I.lead, "lowpass", 3500); I.lead.volume.value = -14;
    I.strings = new Tone.PolySynth(Tone.Synth, { oscillator: { type: "fatsawtooth", count: 3, spread: 30 }, envelope: { attack: 0.5, decay: 0.3, sustain: 0.8, release: 1.5 } });
    via(I.strings, "lowpass", 3000); I.strings.volume.value = -19;
    I.timpani = new Tone.MembraneSynth({ pitchDecay: 0.08, octaves: 3, envelope: { attack: 0.001, decay: 0.6, sustain: 0, release: 0.2 } });
    I.timpani.connect(this.mix); I.timpani.volume.value = -5;
    I.harmony = new Tone.Synth({ oscillator: { type: "triangle" }, envelope: { attack: 0.03, decay: 0.2, sustain: 0.5, release: 0.4 } });
    I.harmony.connect(this.mix); I.harmony.volume.value = -17;
    I.sparkle = new Tone.PolySynth(Tone.Synth, { oscillator: { type: "sine" }, envelope: { attack: 0.002, decay: 0.4, sustain: 0, release: 0.4 } });
    I.sparkle.connect(this.mix); I.sparkle.volume.value = -19;
    I.crash = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 1.6, sustain: 0 } });
    via(I.crash, "highpass", 3000); I.crash.volume.value = -14;
    I.buzzer = new Tone.Synth({ oscillator: { type: "sawtooth" }, envelope: { attack: 0.01, decay: 0.15, sustain: 0.2, release: 0.1 } });
    I.buzzer.connect(this.comp); I.buzzer.volume.value = -12;      // bypasses the muffling filter so it always cuts through

    Tone.Transport.bpm.value = 84; this.lastBpm = 84;
    Tone.Transport.scheduleRepeat((t) => this.tick(t), "16n");
    Tone.Transport.start();
    this.ready = true;
    setInterval(() => this.loop(), 40);
  },

  gainsFor(s, d) {
    if (!s || !s.live) return {};
    if (s.found) return FOUND_GAINS;
    if (!s.running) return { pad: 0.35 };
    if (!s.inBounds) return { pad: 0.3 };
    const g = {}; for (const k in LAYERS) g[k] = LAYERS[k](d);
    return g;
  },

  // One call per 16th note, scheduled by the transport.
  tick(time) {
    const n = this.tickCount++, st = n % 16, bar = Math.floor(n / 16) % 4;
    const s = this.cur;
    if (!s || !s.live) return;
    const G = this.gainsFor(s, this.dS), I = this.inst, ch = CHORDS[bar];
    const g = (k) => G[k] || 0, v = (k, base) => Math.min(1, base * g(k));
    const found = !!s.found;

    if (st === 0 && g("pad") > 0.02) I.pad.triggerAttackRelease(ch.pad, "1m", time, 0.25 + 0.5 * g("pad"));
    if (g("heart") > 0.03 && (st === 0 || st === 8 || ((st === 4 || st === 12) && g("clap") > 0.3)))
      I.heart.triggerAttackRelease("E1", "8n", time, v("heart", 0.8));
    if (g("arp") > 0.03 && st % 2 === 0 && (g("arp") > 0.5 || st % 4 === 0))
      I.arp.triggerAttackRelease(ch.tones[[0, 1, 2, 3, 2, 1, 2, 3][(st / 2) % 8]], "16n", time, v("arp", 0.55));
    if (g("bass") > 0.03 && st in BASS_PATTERN)
      I.bass.triggerAttackRelease(ch.bass[BASS_PATTERN[st]], st === 0 ? "4n" : "8n", time, v("bass", 0.85));
    if (g("hats") > 0.03 && (st % 4 === 2 || (g("hats") > 0.6 && st % 2 === 0) || (found && st % 2 === 1)))
      I.hats.triggerAttackRelease("32n", time, v("hats", 0.7));
    if (g("clap") > 0.03 && (st === 4 || st === 12)) I.clap.triggerAttackRelease("16n", time, v("clap", 0.8));
    if (g("stab") > 0.03 && STAB_STEPS.includes(st)) I.stab.triggerAttackRelease(ch.pad, "16n", time, v("stab", 0.5));
    const mel = MELODY[bar][st];
    if (mel && g("lead") > 0.03) I.lead.triggerAttackRelease(mel, "8n", time, v("lead", 0.8));
    if (st === 0 && g("strings") > 0.03) I.strings.triggerAttackRelease(ch.str, "1m", time, v("strings", 0.6));

    if (found) {   // the symphony extras
      if (st === 0 || st === 8) I.timpani.triggerAttackRelease(ch.bass[0], "8n", time, 0.9);
      if (bar === 3 && st >= 8) I.timpani.triggerAttackRelease(ch.bass[0], "16n", time, 0.25 + 0.75 * ((st - 8) / 7));
      if (mel) I.harmony.triggerAttackRelease(thirdAbove(mel), "8n", time, 0.6);
      if (st % 2 === 1) I.sparkle.triggerAttackRelease(PENTA[(n * 3) % PENTA.length], "32n", time, 0.35);
      if (st === 0 && bar === 0) I.crash.triggerAttackRelease("2n", time, 0.9);
    }
  },

  loop() {   // out-of-bounds warning, independent of the music
    const s = this.cur;
    if (!this.ready || !s || !s.live || !s.running || s.found || s.inBounds) return;
    const now = performance.now();
    if (now - this.lastFire >= 700) { this.lastFire = now; try { this.inst.buzzer.triggerAttackRelease("A2", "8n"); } catch (e) {} }
  },

  finale() {
    const t = Tone.now(), I = this.inst;
    ["C5", "E5", "G5", "C6", "E6", "G6"].forEach((nn, i) => I.arp.triggerAttackRelease(nn, "8n", t + i * 0.1, 0.9));
    I.crash.triggerAttackRelease("2n", t, 1);
    I.strings.triggerAttackRelease(["C4", "E4", "G4", "C5", "E5"], "1m", t, 0.9);
  },

  testTones() {
    const t = Tone.now();
    ["C4", "E4", "G4", "C5"].forEach((nn, i) => this.inst.arp.triggerAttackRelease(nn, "8n", t + i * 0.25, 0.8));
  },

  // s = { live, running, inBounds, found, d } or null to go silent
  update(s) {
    this.cur = s;
    if (!s) { this.dS = null; this.wasFound = false; return; }
    this.dS = this.dS == null ? s.d : this.dS + CONFIG.smoothing * (s.d - this.dS);
    if (!this.ready) { this.wasFound = !!s.found; return; }
    const prox = s.found ? 1 : 1 - Math.min(Math.max(this.dS, 0), 6) / 6;     // 0 far .. 1 on top of the hider
    const open = (s.running && s.inBounds) || s.found;
    this.filt.frequency.rampTo(s.found ? 14000 : open ? 700 * Math.pow(16, prox) : 500, 0.4);   // muffled far, bright close
    this.verb.wet.rampTo(s.found ? 0.18 : 0.45 - 0.3 * prox, 0.4);                              // distant = wet, close = dry
    this.mix.gain.rampTo(!s.live ? 0 : (s.running && !s.inBounds && !s.found) ? 0.35 : 0.8, 0.3);
    const bpm = s.found ? 118 : 84 + 26 * prox;                                                  // tempo climbs as you close in
    if (Math.abs(bpm - this.lastBpm) > 1) { this.lastBpm = bpm; Tone.Transport.bpm.rampTo(bpm, 1.5); }
    if (s.found && !this.wasFound && s.live) this.finale();
    this.wasFound = !!s.found;
  }
};

// Turns a server state message into what the Score needs.
const scoreInput = (st, live) => ({ live, running: st.running && st.trk !== false, inBounds: st.inBounds, found: st.found, d: st.d });

/* =====================================================================
   FLOOR MAP (shared by tracker and hider). World y points up.
   ===================================================================== */
function makeMap(cv) { return { cv, ctx: cv.getContext("2d"), w: 0, h: 0, scale: 1, room: { w: 6, h: 6 } }; }
const mX = (M, x) => (x + CONFIG.mapMargin) * M.scale;
const mY = (M, y) => (M.room.h - y + CONFIG.mapMargin) * M.scale;
const pX = (M, px) => px / M.scale - CONFIG.mapMargin;
const pY = (M, py) => M.room.h + CONFIG.mapMargin - py / M.scale;

function mapFit(M, room) {
  const par = M.cv.parentElement, cs = getComputedStyle(par);
  const avail = par.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); if (!(avail > 0)) return;
  const mm = CONFIG.mapMargin, ww = room.w + 2 * mm, hh = room.h + 2 * mm;
  const w = Math.min(avail, 560), h = Math.min(w * hh / ww, 640);
  const scale = Math.min(w / ww, h / hh);
  const cw = ww * scale, ch = hh * scale;
  if (M.w === cw && M.h === ch && M.room.w === room.w && M.room.h === room.h) return;
  const dpr = window.devicePixelRatio || 1;
  M.cv.style.width = cw + "px"; M.cv.style.height = ch + "px";
  M.cv.width = Math.round(cw * dpr); M.cv.height = Math.round(ch * dpr);
  M.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  M.w = cw; M.h = ch; M.scale = scale; M.room = { w: room.w, h: room.h };
}

function mapPoint(M, e) {
  const r = M.cv.getBoundingClientRect();
  const px = (e.clientX - r.left) * (M.w / r.width), py = (e.clientY - r.top) * (M.h / r.height);
  return { px, py, x: pX(M, px), y: pY(M, py) };
}

// st = server state; over = { seeker, hider } local positions that override st while dragging
function drawMap(M, st, over = {}) {
  if (!st) return;
  mapFit(M, st.room);
  const ctx = M.ctx; if (!M.w) return;
  const sc = M.scale, R = st.room;
  ctx.clearRect(0, 0, M.w, M.h);
  ctx.fillStyle = "#14171d"; ctx.fillRect(0, 0, M.w, M.h);
  const ax = mX(M, 0), ay = mY(M, R.h);
  ctx.fillStyle = "#1b1f27"; ctx.fillRect(ax, ay, R.w * sc, R.h * sc);

  const hp = over.hider || st.hider;
  const sp = over.seeker || st.seeker;
  if (hp) {   // zone rings around the hider
    const hx = mX(M, hp.x), hy = mY(M, hp.y);
    for (let i = ZONES.length - 1; i >= 0; i--) {
      ctx.beginPath(); ctx.arc(hx, hy, ZONES[i].max * sc, 0, Math.PI * 2);
      ctx.fillStyle = ZONES[i].color + "1c"; ctx.fill();
      ctx.strokeStyle = ZONES[i].color + "88"; ctx.lineWidth = 1; ctx.stroke();
    }
  }
  ctx.setLineDash([8, 6]); ctx.strokeStyle = "#cfd5e3"; ctx.lineWidth = 1.5;
  ctx.strokeRect(ax, ay, R.w * sc, R.h * sc); ctx.setLineDash([]);
  ctx.fillStyle = "#98a0b3"; ctx.font = "600 11px system-ui, sans-serif"; ctx.textAlign = "center";
  ctx.fillText("TOP WALL", ax + R.w * sc / 2, ay - 6);

  if (hp && sp) {
    const sx = mX(M, sp.x), sy = mY(M, sp.y), hx = mX(M, hp.x), hy = mY(M, hp.y);
    ctx.strokeStyle = "#ffffff55"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(hx, hy); ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.font = "600 13px system-ui, sans-serif";
    ctx.fillText(Math.hypot(sp.x - hp.x, sp.y - hp.y).toFixed(1) + " m", (sx + hx) / 2, (sy + hy) / 2 - 8);
  }
  const dot = (x, y, col, label) => {
    ctx.beginPath(); ctx.arc(x, y, 16, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = "#0e1015"; ctx.stroke();
    ctx.fillStyle = "#0e1015"; ctx.font = "800 14px system-ui, sans-serif"; ctx.textBaseline = "middle";
    ctx.fillText(label, x, y + 1); ctx.textBaseline = "alphabetic";
  };
  if (hp) dot(mX(M, hp.x), mY(M, hp.y), "#ff4a2b", "H");
  if (sp) {
    const sx = mX(M, sp.x), sy = mY(M, sp.y), live = st.seeker && st.seeker.live;
    const col = !live ? "#6b7385" : st.inBounds ? "#3d8bff" : "#ff5468";   // grey = phone not sending, red = out of bounds
    const hd = st.seeker ? st.seeker.heading : 0;                           // facing arrow
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(hd);
    ctx.beginPath(); ctx.moveTo(0, -30); ctx.lineTo(8, -16); ctx.lineTo(-8, -16); ctx.closePath();
    ctx.fillStyle = col; ctx.fill(); ctx.restore();
    dot(sx, sy, col, "S");
  }
  ctx.textAlign = "start";
}

/* =====================================================================
   TRACKER (laptop)
   ===================================================================== */
const T = { code: null, state: null, monitor: false, map: null, drag: null, dragPos: null, lastPlace: 0 };
const tControl = (msg) => { if (socket && socket.connected) socket.emit("control", msg); };

function trackerOnState(st) {
  T.state = st;
  if (document.activeElement !== $("#t-roomw")) $("#t-roomw").value = st.room.w;
  if (document.activeElement !== $("#t-roomh")) $("#t-roomh").value = st.room.h;
  if (T.monitor) Score.update(scoreInput(st, true));
  renderTracker();
}

function renderTracker() {
  const st = T.state; if (!st) return;
  $("#t-d").textContent = st.trk ? st.d.toFixed(1) : "-";
  drawMap(T.map, st, T.drag ? { [T.drag]: T.dragPos } : {});
}

function trackerSetCode(code) {
  T.code = code;
  try { localStorage.setItem("mmrhc-room", code); } catch (e) {}
  $("#t-code").textContent = code;
}

function initTrackerUI() {
  T.map = makeMap($("#map"));
  const cv = T.map.cv;
  const dragTo = (e, force) => {
    if (!T.drag) return;
    const p = mapPoint(T.map, e);
    T.dragPos = { x: p.x, y: p.y };
    const now = performance.now();
    if (force || now - T.lastPlace > 60) { T.lastPlace = now; tControl({ action: "place", who: T.drag, x: p.x, y: p.y }); }
    renderTracker();
  };
  // Drag S to correct drift; drag H, or tap empty space, to place the hider.
  cv.addEventListener("pointerdown", (e) => {
    const st = T.state; if (!st) return;
    const p = mapPoint(T.map, e);
    const near = (q) => q ? Math.hypot(p.px - mX(T.map, q.x), p.py - mY(T.map, q.y)) : Infinity;
    const ds = near(st.seeker), dh = near(st.hider);
    T.drag = (ds <= 36 && ds <= dh) ? "seeker" : "hider";
    try { cv.setPointerCapture(e.pointerId); } catch (err) {}
    dragTo(e, true);
  });
  cv.addEventListener("pointermove", dragTo);
  cv.addEventListener("pointerup", (e) => { if (T.drag) { dragTo(e, true); T.drag = null; T.dragPos = null; } });
  cv.addEventListener("pointercancel", () => { T.drag = null; T.dragPos = null; });
  window.addEventListener("resize", () => { T.map.w = 0; renderTracker(); });

  const sendRoom = () => tControl({ action: "room", w: parseFloat($("#t-roomw").value) || 6, h: parseFloat($("#t-roomh").value) || 6 });
  $("#t-roomw").addEventListener("change", sendRoom);
  $("#t-roomh").addEventListener("change", sendRoom);

  $("#t-start").addEventListener("click", () => { Score.wasFound = false; tControl({ action: "start" }); });
  $("#t-stop").addEventListener("click", () => tControl({ action: "pause" }));
  $("#t-found").addEventListener("click", () => tControl({ action: "found" }));
  $("#t-monitor").addEventListener("click", async () => {
    if (!T.monitor) {
      try { await Score.init(); } catch (e) { alert(e.message); return; }
      T.monitor = true; Score.testTones();
    } else { T.monitor = false; Score.update(null); }
    $("#t-monitor").textContent = "Play audio here: " + (T.monitor ? "ON" : "off");
    $("#t-monitor").className = T.monitor ? "on" : "";
  });
}

function startTracker() {
  $("#home").hidden = true; $("#tracker").hidden = false;
  keepAwake();
  initTrackerUI();
  let saved = null;
  try { saved = localStorage.getItem("mmrhc-room"); } catch (e) {}
  connectServer(() => socket.emit("tracker_open", { code: T.code || (isCode(saved) ? saved : null) }));
  if (!socket) return;
  socket.on("opened", (m) => { T.state = null; trackerSetCode(m.code); });
  socket.on("state", trackerOnState);
}

/* =====================================================================
   SEEKER: pedestrian dead reckoning (steps + compass) -> position -> server
   ===================================================================== */
const S = {
  code: null, joined: false, state: null, lastMsgAt: 0,
  me: { x: 3, y: 3 }, heading: 0, pending: { x: 0, y: 0 },
  sensorsOn: false, motionSeen: false, compass: null, headingOffset: 0,
  gEst: 9.81, smA: 0, prevA: 0, lastStepT: 0,
  keys: new Set(), lastLoop: performance.now(), lastSend: 0
};

async function enableSensors() {
  let warn = "";
  try {   // iPhone (and some newer browsers) need an explicit permission prompt from a button tap
    const ask = (C) => (typeof C !== "undefined" && typeof C.requestPermission === "function") ? C.requestPermission() : "granted";
    const [m, o] = await Promise.all([ask(window.DeviceMotionEvent), ask(window.DeviceOrientationEvent)]);
    if (m !== "granted" || o !== "granted") warn = "Motion permission was refused. iPhone: Settings > Safari > Motion & Orientation Access, then reload.";
  } catch (e) { warn = "Sensor permission error: " + e.message; }
  if (!window.isSecureContext) warn += (warn ? " " : "") + "This page isn't https, so most phones block the sensors.";
  if (!S.sensorsOn) {   // listen anyway: some browsers deliver data even after a refused prompt
    window.addEventListener("devicemotion", onMotion);
    window.addEventListener("deviceorientationabsolute", onOrient, true);
    window.addEventListener("deviceorientation", onOrient, true);
  }
  S.sensorsOn = true;
  $("#s-sensors").textContent = "Sensors on";
  setTimeout(() => {   // only complain if no data actually arrives
    if (!S.motionSeen) alert((warn ? warn + "\n\n" : "") + "No motion data is arriving from this phone. The tracker can still move the seeker's dot on the map.");
  }, 2500);
}

function onOrient(e) {
  if (typeof e.webkitCompassHeading === "number") S.compass = e.webkitCompassHeading;                                    // iOS
  else if ((e.absolute || e.type === "deviceorientationabsolute") && e.alpha != null) S.compass = (360 - e.alpha) % 360;  // Android
}

function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  S.motionSeen = true;
  const m = Math.hypot(a.x, a.y, a.z);
  S.gEst += (m - S.gEst) * 0.02;                 // slow baseline = gravity
  S.smA += ((m - S.gEst) - S.smA) * 0.4;         // light smoothing
  const now = performance.now();
  if (S.prevA < CONFIG.stepThresh && S.smA >= CONFIG.stepThresh && now - S.lastStepT > CONFIG.stepMinMs) {
    S.lastStepT = now;
    const h = S.compass !== null ? (S.compass - S.headingOffset) * Math.PI / 180 : S.heading;
    S.pending.x += CONFIG.stepLength * Math.sin(h);
    S.pending.y += CONFIG.stepLength * Math.cos(h);
  }
  S.prevA = S.smA;
}

function calibrate() {   // current facing direction = towards the top wall; position = room centre
  if (S.compass !== null) S.headingOffset = S.compass;
  const r = S.state ? S.state.room : { w: 6, h: 6 };
  S.me = { x: r.w / 2, y: r.h / 2 }; S.pending = { x: 0, y: 0 }; S.heading = 0;
  sendPos(true);
  $("#s-calib").textContent = "Calibrated. Tap again to re-centre";
}

function sendPos(force) {
  const now = performance.now();
  if (!S.joined || !socket || !socket.connected) return;
  if (!force && now - S.lastSend < CONFIG.sendIntervalMs) return;
  S.lastSend = now;
  socket.emit("move", { x: S.me.x, y: S.me.y, heading: S.heading });
}

function seekerLoop() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - S.lastLoop) / 1000); S.lastLoop = now;
  const r = S.state ? S.state.room : { w: 6, h: 6 }, mg = 1;
  if (S.sensorsOn) {
    if (S.compass !== null) S.heading = (S.compass - S.headingOffset) * Math.PI / 180;
    const pl = Math.hypot(S.pending.x, S.pending.y);
    if (pl > 0) {                                   // glide each step so distance changes smoothly
      const mv = Math.min(pl, (CONFIG.stepLength / CONFIG.stepGlideS) * dt), ux = S.pending.x / pl, uy = S.pending.y / pl;
      S.me.x = clamp(S.me.x + ux * mv, -mg, r.w + mg); S.me.y = clamp(S.me.y + uy * mv, -mg, r.h + mg);
      S.pending.x -= ux * mv; S.pending.y -= uy * mv;
    }
  }
  // laptop testing: arrow keys / WASD walk the seeker
  let dx = 0, dy = 0;
  if (S.keys.has("ArrowLeft") || S.keys.has("a")) dx -= 1;
  if (S.keys.has("ArrowRight") || S.keys.has("d")) dx += 1;
  if (S.keys.has("ArrowUp") || S.keys.has("w")) dy += 1;
  if (S.keys.has("ArrowDown") || S.keys.has("s")) dy -= 1;
  const mag = Math.hypot(dx, dy);
  if (mag > 0) {
    const v = CONFIG.keyboardSpeed;
    S.me.x = clamp(S.me.x + dx / mag * v * dt, -mg, r.w + mg);
    S.me.y = clamp(S.me.y + dy / mag * v * dt, -mg, r.h + mg);
    if (!S.sensorsOn || S.compass === null) S.heading = Math.atan2(dx, dy);
  }
  sendPos(false);       // 10 Hz heartbeat even when standing still, so the link stays live
}

const seekerLive = () => Date.now() - S.lastMsgAt < CONFIG.staleMs;

function seekerRender() {
  const st = S.state;
  if (st) {
    const d = Score.dS != null ? Score.dS : st.d;
    $("#s-d").textContent = st.trk === false ? "-" : d.toFixed(1);
  }
}

function seekerPush() {
  const st = S.state;
  if (!st) { Score.update(null); return; }
  Score.update(scoreInput(st, seekerLive()));
}

async function seekerJoin(code) {
  S.code = code;
  $("#s-joinerr").hidden = true;
  try { await Score.init(); Score.testTones(); } catch (e) { alert(e.message); }   // must happen inside the tap so audio is allowed
  keepAwake();
  if (socket) { if (socket.connected) socket.emit("join", { code, role: "seeker" }); return; }
  connectServer(() => socket.emit("join", { code: S.code, role: "seeker" }));
  if (!socket) return;
  socket.on("joined", (m) => {
    S.joined = true;
    if (m.x != null) S.me = { x: m.x, y: m.y };
    $("#s-join").hidden = true; $("#s-live").hidden = false;
  });
  socket.on("join_error", (m) => {
    S.joined = false;
    $("#s-join").hidden = false; $("#s-live").hidden = true;
    $("#s-joinerr").textContent = m.message; $("#s-joinerr").hidden = false;
  });
  socket.on("state", (st) => { S.state = st; S.lastMsgAt = Date.now(); });
  socket.on("set_pos", (p) => { S.me = { x: p.x, y: p.y }; S.pending = { x: 0, y: 0 }; });   // tracker corrected drift
  setInterval(seekerLoop, 50);
  setInterval(() => { seekerPush(); seekerRender(); }, 100);
}

function startSeeker(prefill) {
  $("#home").hidden = true; $("#seeker").hidden = false;
  const input = $("#s-code");
  if (prefill) input.value = prefill;
  input.addEventListener("input", () => { input.value = cleanCode(input.value); });
  $("#s-joinbtn").addEventListener("click", () => {
    const code = cleanCode(input.value.trim());
    if (!isCode(code)) { showJoinError("#s-joinerr", input); return; }
    seekerJoin(code);
  });
  $("#s-sensors").addEventListener("click", enableSensors);
  $("#s-calib").addEventListener("click", calibrate);
  window.addEventListener("keydown", (e) => {
    if (e.target && e.target.tagName === "INPUT") return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k.startsWith("Arrow")) e.preventDefault();
    S.keys.add(k);
  });
  window.addEventListener("keyup", (e) => S.keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
  window.addEventListener("blur", () => S.keys.clear());
}

/* =====================================================================
   HIDER: tap the map where you are hiding
   ===================================================================== */
const H = { code: null, joined: false, state: null, me: null, map: null, dragging: false };

function hiderJoin(code) {
  H.code = code;
  $("#h-joinerr").hidden = true;
  keepAwake();
  if (socket) { if (socket.connected) socket.emit("join", { code, role: "hider" }); return; }
  connectServer(() => {
    socket.emit("join", { code: H.code, role: "hider" });
    if (H.me) setTimeout(() => socket.emit("move", H.me), 300);   // re-send our spot after a reconnect
  });
  if (!socket) return;
  socket.on("joined", (m) => {
    H.joined = true;
    if (m.x != null) H.me = { x: m.x, y: m.y };
    $("#h-join").hidden = true; $("#h-live").hidden = false;
  });
  socket.on("join_error", (m) => { $("#h-joinerr").textContent = m.message; $("#h-joinerr").hidden = false; });
  socket.on("state", (st) => {
    H.state = st;
    if (st.hider && !H.dragging) H.me = { x: st.hider.x, y: st.hider.y };
    drawMap(H.map, st, H.me ? { hider: H.me } : {});
  });
  socket.on("set_pos", (p) => { H.me = { x: p.x, y: p.y }; });
}

function startHider(prefill) {
  $("#home").hidden = true; $("#hider").hidden = false;
  H.map = makeMap($("#h-map"));
  const input = $("#h-code");
  if (prefill) input.value = prefill;
  input.addEventListener("input", () => { input.value = cleanCode(input.value); });
  $("#h-joinbtn").addEventListener("click", () => {
    const code = cleanCode(input.value.trim());
    if (!isCode(code)) { showJoinError("#h-joinerr", input); return; }
    hiderJoin(code);
  });
  const place = (e) => {
    if (!H.joined || !H.state) return;
    const p = mapPoint(H.map, e), R = H.state.room;
    H.me = { x: clamp(p.x, 0, R.w), y: clamp(p.y, 0, R.h) };
    socket.emit("move", H.me);
    drawMap(H.map, H.state, { hider: H.me });
  };
  H.map.cv.addEventListener("pointerdown", (e) => { H.dragging = true; try { H.map.cv.setPointerCapture(e.pointerId); } catch (err) {} place(e); });
  H.map.cv.addEventListener("pointermove", (e) => { if (H.dragging) place(e); });
  ["pointerup", "pointercancel"].forEach((ev) => H.map.cv.addEventListener(ev, () => { H.dragging = false; }));
  window.addEventListener("resize", () => { H.map.w = 0; if (H.state) drawMap(H.map, H.state, H.me ? { hider: H.me } : {}); });
}

/* ---------- Boot ---------- */
(function boot() {
  const q = new URLSearchParams(location.search);
  const role = q.get("role"), room = cleanCode(q.get("room") || "");
  $("#go-tracker").addEventListener("click", startTracker);
  $("#go-seeker").addEventListener("click", () => startSeeker(""));
  $("#go-hider").addEventListener("click", () => startHider(""));
  ["#t-back", "#s-back", "#h-back"].forEach((id) => $(id).addEventListener("click", () => { location.href = location.pathname; }));
  if (role === "seeker") startSeeker(isCode(room) ? room : "");
  else if (role === "hider") startHider(isCode(room) ? room : "");
  else if (role === "tracker") startTracker();
})();