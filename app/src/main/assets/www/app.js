'use strict';
// ===================== общее =====================
const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
let AC = null;
function ac() {
  if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
  if (AC.state === 'suspended') AC.resume();
  return AC;
}
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toast(t, ms = 2600) {
  const e = $('#toast'); e.textContent = t; e.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => e.classList.remove('show'), ms);
}
async function busy(text, fn) {
  $('#busyText').textContent = text; $('#busy').hidden = false;
  await sleep(30); // дать отрисоваться
  try { return await fn(); } finally { $('#busy').hidden = true; }
}

// ---------- воспроизведение ----------
const Player = {
  src: null, onEnd: null, start: 0,
  play(buffer, onEnd) {
    this.stop();
    const c = ac();
    const s = c.createBufferSource(); s.buffer = buffer; s.connect(c.destination);
    s.onended = () => { if (this.src === s) { this.src = null; const f = this.onEnd; this.onEnd = null; f && f(); } };
    this.src = s; this.onEnd = onEnd; this.start = c.currentTime + 0.02;
    s.start(this.start);
  },
  stop() {
    if (this.src) { const s = this.src; this.src = null; try { s.stop(); } catch (e) {} const f = this.onEnd; this.onEnd = null; f && f(); }
  },
  pos() { return this.src ? ac().currentTime - this.start : -1; },
  get playing() { return !!this.src; }
};
window.onAndroidPause = () => Player.stop();

function toBuffer(chs, sr) {
  const b = ac().createBuffer(chs.length, chs[0].length, sr);
  chs.forEach((c, i) => b.copyToChannel(c, i));
  return b;
}

// ---------- сохранение файлов ----------
function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function saveFile(name, u8, mime, share) {
  if (window.AndroidBridge) {
    const data = b64(u8);
    return share ? AndroidBridge.shareFile(name, data, mime) : AndroidBridge.saveFile(name, data, mime);
  }
  const url = URL.createObjectURL(new Blob([u8], { type: mime }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getDate())}${p(d.getMonth() + 1)}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

// ===================== запись с микрофона / из файла =====================
class Recorder {
  async start(onChunk) {
    const c = ac();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    this.src = c.createMediaStreamSource(this.stream);
    this.proc = c.createScriptProcessor(4096, 1, 1);
    this.mute = c.createGain(); this.mute.gain.value = 0;
    this.chunks = []; this.sr = c.sampleRate;
    this.proc.onaudioprocess = (e) => { const d = new Float32Array(e.inputBuffer.getChannelData(0)); this.chunks.push(d); onChunk && onChunk(d, this.sr); };
    this.src.connect(this.proc); this.proc.connect(this.mute); this.mute.connect(c.destination);
  }
  stop() {
    try { this.src.disconnect(); this.proc.disconnect(); this.mute.disconnect(); } catch (e) {}
    this.stream && this.stream.getTracks().forEach((t) => t.stop());
    const n = this.chunks.reduce((a, b) => a + b.length, 0);
    const x = new Float32Array(n); let o = 0;
    this.chunks.forEach((ch) => { x.set(ch, o); o += ch.length; });
    this.chunks = [];
    return { x, sr: this.sr };
  }
}

async function decodeFile(file) {
  const buf = await file.arrayBuffer();
  const ab = await new Promise((res, rej) => ac().decodeAudioData(buf, res, rej));
  const x = new Float32Array(ab.length);
  for (let c = 0; c < ab.numberOfChannels; c++) { const d = ab.getChannelData(c); for (let i = 0; i < x.length; i++) x[i] += d[i] / ab.numberOfChannels; }
  return { x, sr: ab.sampleRate };
}

function drawWave(cv, x) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  if (!x || !x.length) return;
  const grd = g.createLinearGradient(0, 0, w, 0); grd.addColorStop(0, '#ff4f9a'); grd.addColorStop(1, '#8b5cf6');
  g.fillStyle = grd;
  const bars = Math.floor(w / 4), step = x.length / bars;
  let peak = 1e-6; for (let i = 0; i < x.length; i += 64) peak = Math.max(peak, Math.abs(x[i]));
  for (let b = 0; b < bars; b++) {
    let m = 0; const s = Math.floor(b * step), e = Math.floor((b + 1) * step);
    for (let i = s; i < e; i += 16) m = Math.max(m, Math.abs(x[i]));
    const bh = Math.max(2, (m / peak) * (h - 4));
    g.fillRect(b * 4, (h - bh) / 2, 2.5, bh);
  }
}

// Блок записи: большая кнопка, живая нота (для мелодии), волна, загрузка файла
function makeInput(root, opts) {
  const card = el('div', 'card rec-card');
  card.innerHTML = `
    <button class="rec-btn"><span class="ring"></span><span class="ico">🎙</span></button>
    <div class="rec-status">${opts.title}</div>
    <div class="rec-sub">${opts.sub}</div>
    ${opts.live ? '<div class="live-note"></div><div class="tuner"><i></i></div>' : ''}
    <canvas class="wave" hidden></canvas>
    <div class="row">
      <button class="btn ghost f">📁 Из файла</button>
      <button class="btn ghost p" hidden>▶ Оригинал</button>
    </div>
    <input type="file" accept="audio/*" hidden>`;
  root.appendChild(card);
  const btn = card.querySelector('.rec-btn'), ring = card.querySelector('.ring'), ico = card.querySelector('.ico');
  const st = card.querySelector('.rec-status'), sub = card.querySelector('.rec-sub');
  const wave = card.querySelector('.wave'), inp = card.querySelector('input');
  const noteEl = card.querySelector('.live-note'), tun = card.querySelector('.tuner i');
  const pBtn = card.querySelector('.p');
  let rec = null, t0 = 0, timer = null, last = null;

  const setAudio = (x, sr, fromRec) => {
    x = DSP.trimSilence(x, sr);
    if (x.length < sr * 0.4) { toast('Слишком короткая запись — попробуй ещё раз'); return; }
    DSP.normalize(x, 0.9);
    last = { x, sr };
    wave.hidden = false; wave._x = x; drawWave(wave, x); pBtn.hidden = false;
    st.textContent = 'Запись готова · ' + (x.length / sr).toFixed(1) + ' с';
    sub.textContent = 'Нажми микрофон, чтобы перезаписать';
    opts.onAudio(x, sr);
  };

  const stopRec = () => {
    if (!rec) return;
    clearInterval(timer);
    const r = rec.stop(); rec = null;
    btn.classList.remove('on'); ico.textContent = '🎙'; ring.style.transform = 'scale(1)';
    if (noteEl) { noteEl.textContent = ''; }
    setAudio(r.x, r.sr, true);
  };

  btn.onclick = async () => {
    if (rec) { stopRec(); return; }
    Player.stop();
    try {
      rec = new Recorder();
      let buf = [], bufLen = 0;
      await rec.start((d, sr) => {
        let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i];
        const lvl = Math.min(1, Math.sqrt(s / d.length) * 6);
        ring.style.transform = `scale(${1 + lvl * 0.35})`;
        if (opts.live) {
          buf.push(d); bufLen += d.length;
          if (bufLen >= 4096) {
            const x = new Float32Array(bufLen); let o = 0; buf.forEach((c) => { x.set(c, o); o += c.length; }); buf = []; bufLen = 0;
            const tr = DSP.yinTrack(x, sr);
            const f = Array.from(tr.f0).filter((v) => v > 0);
            if (f.length >= 2) {
              const m = 69 + 12 * Math.log2(DSP.median(f) / 440), r = Math.round(m);
              noteEl.textContent = DSP.NOTE_NAMES[((r % 12) + 12) % 12] + ' ' + (Math.floor(r / 12) - 1);
              tun.style.left = (43 + (m - r) * 80) + '%';
            } else noteEl.textContent = '·';
          }
        }
      });
      btn.classList.add('on'); ico.textContent = '⏹';
      t0 = Date.now(); st.textContent = 'Идёт запись… 0.0 с'; sub.textContent = 'Нажми ещё раз, чтобы закончить';
      timer = setInterval(() => {
        const s = (Date.now() - t0) / 1000;
        st.textContent = 'Идёт запись… ' + s.toFixed(1) + ' с';
        if (s >= 60) stopRec();
      }, 100);
    } catch (e) {
      rec = null;
      toast('Нет доступа к микрофону. Разреши его в настройках или выбери запись из файла', 4000);
    }
  };
  card.querySelector('.f').onclick = () => { Player.stop(); inp.click(); };
  inp.onchange = async () => {
    const f = inp.files[0]; inp.value = '';
    if (!f) return;
    try {
      const r = await busy('Открываю файл…', () => decodeFile(f));
      setAudio(r.x, r.sr, false);
    } catch (e) { toast('Не получилось открыть этот файл. Попробуй mp3, m4a или wav'); }
  };
  pBtn.onclick = () => {
    if (!last) return;
    if (Player.playing && pBtn.textContent.startsWith('⏹')) { Player.stop(); return; }
    Player.play(toBuffer([last.x], last.sr), () => { pBtn.textContent = '▶ Оригинал'; });
    pBtn.textContent = '⏹ Оригинал';
  };
  return {
    get audio() { return last; },
    set(x, sr) { setAudio(Float32Array.from(x), sr, false); }
  };
}

// ===================== синтезатор =====================
const Synth = (() => {
  const noiseCache = {};
  function noiseBuf(c) {
    const sr = c.sampleRate;
    if (!noiseCache[sr]) {
      const b = c.createBuffer(1, sr * 2, sr), d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      noiseCache[sr] = b;
    }
    return noiseCache[sr];
  }
  function impulse(c, sec, decay, ch = 2) {
    const sr = c.sampleRate, n = Math.floor(sr * sec), b = c.createBuffer(ch, n, sr);
    for (let k = 0; k < ch; k++) {
      const d = b.getChannelData(k);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
    }
    return b;
  }
  function pulse(c) {
    const N = 32, re = new Float32Array(N), im = new Float32Array(N), duty = 0.25;
    for (let k = 1; k < N; k++) im[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty) * 1, re[k] = 0;
    return c.createPeriodicWave(re, im);
  }
  function shaper(c, amt) {
    const ws = c.createWaveShaper(), n = 2048, cur = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; cur[i] = Math.tanh(x * amt) / Math.tanh(amt); }
    ws.curve = cur; ws.oversample = '2x';
    return ws;
  }
  // огибающая
  function envG(c, t, d, o) {
    const g = c.createGain(), G = g.gain;
    const a = o.a || 0.005, pk = o.pk, s = o.s == null ? 0.6 : o.s, dec = o.dec || 0.3, r = o.r || 0.15;
    G.setValueAtTime(0.0001, t);
    G.linearRampToValueAtTime(pk, t + a);
    G.setTargetAtTime(Math.max(0.0001, pk * s), t + a, dec / 3);
    const off = t + Math.max(d, a + 0.01);
    G.setTargetAtTime(0.0001, off, r / 3);
    return { g, end: off + r * 2.5 };
  }
  function osc(c, type, f, t, end, dest, gain = 1, det = 0) {
    const o = c.createOscillator();
    if (type === 'pulse') o.setPeriodicWave(pulse(c)); else o.type = type;
    o.frequency.value = f; o.detune.value = det;
    let node = o;
    if (gain !== 1) { const g = c.createGain(); g.gain.value = gain; o.connect(g); node = g; }
    node.connect(dest); o.start(t); o.stop(end);
    return o;
  }
  function vibrato(c, o, t, end, rate = 5.5, cents = 12, delay = 0.25) {
    const l = c.createOscillator(), g = c.createGain();
    l.frequency.value = rate; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(cents, t + delay + 0.2);
    l.connect(g); (Array.isArray(o) ? o : [o]).forEach((x) => g.connect(x.detune));
    l.start(t); l.stop(end);
  }

  const I = {
    piano(c, out, m, t, d, v) {
      const f = mtof(m), { g, end } = envG(c, t, d, { a: 0.004, pk: 0.42 * v, s: 0.12, dec: 0.9, r: 0.3 });
      const lp = c.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.setValueAtTime(Math.min(9000, f * 10), t); lp.frequency.exponentialRampToValueAtTime(Math.max(400, f * 2.5), t + 1.2);
      g.connect(lp); lp.connect(out);
      osc(c, 'triangle', f, t, end, g); osc(c, 'sine', f * 2, t, end, g, 0.35); osc(c, 'sawtooth', f, t, end, g, 0.06, 4);
    },
    epiano(c, out, m, t, d, v) {
      const f = mtof(m), { g, end } = envG(c, t, d, { a: 0.006, pk: 0.36 * v, s: 0.25, dec: 1.4, r: 0.35 });
      g.connect(out);
      const car = c.createOscillator(); car.frequency.value = f;
      const mod = c.createOscillator(); mod.frequency.value = f;
      const mg = c.createGain(); mg.gain.setValueAtTime(f * 1.6, t); mg.gain.exponentialRampToValueAtTime(f * 0.2, t + 0.6);
      mod.connect(mg); mg.connect(car.frequency); car.connect(g);
      car.start(t); mod.start(t); car.stop(end); mod.stop(end);
      osc(c, 'sine', f * 2, t, Math.min(end, t + 0.4), g, 0.08);
    },
    vibes(c, out, m, t, d, v) {
      const f = mtof(m), { g, end } = envG(c, t, Math.max(d, 0.6), { a: 0.003, pk: 0.4 * v, s: 0.25, dec: 1.6, r: 0.6 });
      const tr = c.createGain(); tr.gain.value = 0.8;
      const l = c.createOscillator(), lg = c.createGain(); l.frequency.value = 5.2; lg.gain.value = 0.2; l.connect(lg); lg.connect(tr.gain); l.start(t); l.stop(end);
      g.connect(tr); tr.connect(out);
      osc(c, 'sine', f, t, end, g); osc(c, 'sine', f * 4, t, Math.min(end, t + 0.25), g, 0.12);
    },
    bell(c, out, m, t, d, v) {
      const f = mtof(m), { g, end } = envG(c, t, Math.max(d, 0.3), { a: 0.002, pk: 0.3 * v, s: 0.05, dec: 1.0, r: 0.8 });
      g.connect(out);
      osc(c, 'sine', f, t, end, g); osc(c, 'sine', f * 2, t, end, g, 0.25); osc(c, 'sine', f * 5.4, t, Math.min(end, t + 0.15), g, 0.15);
    },
    sawlead(c, out, m, t, d, v) {
      const f = mtof(m), { g, end } = envG(c, t, d, { a: 0.01, pk: 0.2 * v, s: 0.85, dec: 0.2, r: 0.12 });
      const ws = shaper(c, 3), lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3600;
      g.connect(ws); ws.connect(lp); lp.connect(out);
      const o1 = osc(c, 'sawtooth', f, t, end, g, 0.5, -8), o2 = osc(c, 'sawtooth', f, t, end, g, 0.5, 8);
      vibrato(c, [o1, o2], t, end, 5.5, 18);
    },
    strings(c, out, m, t, d, v) {
      const f = mtof(m), { g, end } = envG(c, t, d, { a: 0.16, pk: 0.17 * v, s: 0.9, dec: 0.3, r: 0.45 });
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2300;
      g.connect(lp); lp.connect(out);
      const os = [-11, 0, 11].map((dt) => osc(c, 'sawtooth', f, t, end, g, 0.4, dt));
      vibrato(c, os, t, end, 5.2, 10, 0.2);
    },
    square(c, out, m, t, d, v) {
      const f = mtof(m), { g, end } = envG(c, t, d, { a: 0.002, pk: 0.13 * v, s: 0.75, dec: 0.12, r: 0.04 });
      g.connect(out);
      const o = osc(c, 'pulse', f, t, end, g);
      vibrato(c, o, t, end, 6, 14, 0.3);
    },
    supersaw(c, out, m, t, d, v) {
      const f = mtof(m), { g, end } = envG(c, t, d, { a: 0.01, pk: 0.1 * v, s: 0.85, dec: 0.2, r: 0.2 });
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5500;
      g.connect(lp); lp.connect(out);
      [-24, -12, 0, 12, 24].forEach((dt) => osc(c, 'sawtooth', f, t, end, g, 0.3, dt));
      osc(c, 'sawtooth', f / 2, t, end, g, 0.25);
    },
    pad(c, out, m, t, d, v) {
      const f = mtof(m), { g, end } = envG(c, t, d, { a: 0.02, pk: 0.08 * v, s: 0.9, dec: 0.2, r: 0.12 });
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
      g.connect(lp); lp.connect(out);
      [-14, 0, 14].forEach((dt) => osc(c, 'sawtooth', f, t, end, g, 0.4, dt));
    },
    guitar(c, out, m, t, d, v) {
      const f = mtof(m), { g, end } = envG(c, t, d, { a: 0.003, pk: 0.11 * v, s: 0.55, dec: 0.18, r: 0.06 });
      const ws = shaper(c, 8), lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600;
      g.connect(ws); ws.connect(lp); lp.connect(out);
      osc(c, 'sawtooth', f, t, end, g, 0.5); osc(c, 'sawtooth', f * 1.004, t, end, g, 0.5);
    },
    pluck(c, out, m, t, d, v) {
      const f = mtof(m), { g, end } = envG(c, t, d, { a: 0.004, pk: 0.45 * v, s: 0.5, dec: 0.3, r: 0.08 });
      const lp = c.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.setValueAtTime(1400, t); lp.frequency.exponentialRampToValueAtTime(260, t + 0.3);
      g.connect(lp); lp.connect(out);
      osc(c, 'sawtooth', f, t, end, g, 0.6); osc(c, 'sine', f, t, end, g, 0.6);
    },
    upright(c, out, m, t, d, v) {
      const f = mtof(m), { g, end } = envG(c, t, d, { a: 0.012, pk: 0.55 * v, s: 0.3, dec: 0.4, r: 0.1 });
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
      g.connect(lp); lp.connect(out);
      osc(c, 'sine', f, t, end, g); osc(c, 'triangle', f, t, end, g, 0.5);
    },
    pizz(c, out, m, t, d, v) {
      const f = mtof(m), { g, end } = envG(c, t, 0.12, { a: 0.003, pk: 0.45 * v, s: 0.05, dec: 0.18, r: 0.15 });
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1300;
      g.connect(lp); lp.connect(out);
      osc(c, 'triangle', f, t, end, g); osc(c, 'sawtooth', f, t, end, g, 0.25);
    },
    tri(c, out, m, t, d, v) {
      const f = mtof(m), { g, end } = envG(c, t, d, { a: 0.002, pk: 0.4 * v, s: 0.9, dec: 0.1, r: 0.03 });
      g.connect(out); osc(c, 'triangle', f, t, end, g);
    },
    sub(c, out, m, t, d, v) {
      const f = mtof(m), { g, end } = envG(c, t, d, { a: 0.005, pk: 0.55 * v, s: 0.9, dec: 0.1, r: 0.05 });
      g.connect(out); osc(c, 'sine', f, t, end, g); osc(c, 'triangle', f * 2, t, end, g, 0.15);
    }
  };

  function noiseHit(c, out, t, v, { type = 'highpass', f = 7000, q = 0.7, dec = 0.05, a = 0.001 }) {
    const s = c.createBufferSource(); s.buffer = noiseBuf(c);
    const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + a); g.gain.setTargetAtTime(0.0001, t + a, dec / 3);
    s.connect(fl); fl.connect(g); g.connect(out);
    s.start(t, Math.random() * 1.5); s.stop(t + dec * 3 + 0.05);
  }
  const D = {
    kick(c, out, t, v) {
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.5);
      noiseHit(c, out, t, v * 0.15, { f: 3000, dec: 0.01 });
    },
    snare(c, out, t, v) {
      noiseHit(c, out, t, v * 0.45, { type: 'bandpass', f: 1900, q: 0.7, dec: 0.17 });
      const o = c.createOscillator(), g = c.createGain(); o.type = 'triangle'; o.frequency.setValueAtTime(200, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.08);
      g.gain.setValueAtTime(v * 0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.15);
    },
    clap(c, out, t, v) {
      [0, 0.012, 0.024].forEach((dt) => noiseHit(c, out, t + dt, v * 0.35, { type: 'bandpass', f: 1500, q: 1, dec: 0.02 }));
      noiseHit(c, out, t + 0.03, v * 0.35, { type: 'bandpass', f: 1500, q: 1, dec: 0.2 });
    },
    hat(c, out, t, v) { noiseHit(c, out, t, v * 0.25, { f: 7500, dec: 0.045 }); },
    ohat(c, out, t, v) { noiseHit(c, out, t, v * 0.22, { f: 7000, dec: 0.25 }); },
    ride(c, out, t, v) { noiseHit(c, out, t, v * 0.16, { type: 'bandpass', f: 7000, q: 0.6, dec: 0.5 }); },
    crash(c, out, t, v) { noiseHit(c, out, t, v * 0.3, { f: 3500, dec: 1.6 }); },
    tim(c, out, t, v) {
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(82, t + 0.4);
      g.gain.setValueAtTime(v * 0.75, t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.3);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + 1.4);
      noiseHit(c, out, t, v * 0.2, { type: 'lowpass', f: 400, dec: 0.08 });
    }
  };
  return { I, D, impulse, shaper, noiseBuf };
})();

// ===================== вкладка «Напой» =====================
const STYLES = [
  { id: 'piano', name: 'Пианино', e: '🎹', lead: 'piano', ch: 'piano', bassI: 'upright', chordMode: 'block', bassMode: 'root', drums: 'none', reverb: 0.25, prog: { lead: 0, chords: 0, bass: 32 } },
  { id: 'lofi', name: 'Лоу-фай', e: '☕', lead: 'epiano', ch: 'epiano', bassI: 'upright', chordMode: 'pad', bassMode: 'root', drums: 'lofi', swing: 0.17, ext: true, reverb: 0.2, lp: 3300, crackle: true, prog: { lead: 4, chords: 4, bass: 32 } },
  { id: 'rock', name: 'Рок', e: '🎸', lead: 'sawlead', ch: 'guitar', bassI: 'pluck', chordMode: 'power', bassMode: 'root8', drums: 'rock', reverb: 0.12, prog: { lead: 29, chords: 30, bass: 33 } },
  { id: 'orch', name: 'Оркестр', e: '🎻', lead: 'strings', ch: 'strings', bassI: 'pizz', chordMode: 'pad', bassMode: 'pizz', drums: 'orch', reverb: 0.45, chordOct: -1, prog: { lead: 40, chords: 48, bass: 45 } },
  { id: 'jazz', name: 'Джаз', e: '🎷', lead: 'vibes', ch: 'piano', bassI: 'upright', chordMode: 'comp', bassMode: 'walk', drums: 'jazz', swing: 0.17, ext: true, reverb: 0.25, prog: { lead: 11, chords: 0, bass: 32 } },
  { id: 'chip', name: '8-бит', e: '👾', lead: 'square', ch: 'square', bassI: 'tri', chordMode: 'arp', bassMode: 'chip', drums: 'chip', reverb: 0.05, prog: { lead: 80, chords: 80, bass: 38 } },
  { id: 'edm', name: 'Электро', e: '⚡', lead: 'supersaw', ch: 'pad', bassI: 'sub', chordMode: 'offbeat', bassMode: 'offbeat', drums: 'edm', reverb: 0.2, pump: true, prog: { lead: 81, chords: 89, bass: 38 } },
  { id: 'box', name: 'Шкатулка', e: '🎠', lead: 'bell', ch: 'bell', bassI: 'tri', chordMode: 'box', bassMode: 'none', drums: 'none', reverb: 0.35, leadOct: 1, prog: { lead: 10, chords: 10, bass: 32 } }
];

const Hum = {
  notes: null, key: null, bpmDetected: 100, bpm: 100, tr: 0, snap: true, style: STYLES[0], cont: [],
  arr: null, buffer: null, dirty: true, renderId: 0, raw: null,

  init() {
    this.input = makeInput($('#humInput'), {
      title: 'Нажми и напой', sub: 'Мычи, свисти или пой «ла-ла» — до 60 секунд', live: true,
      onAudio: (x, sr) => this.analyze(x, sr)
    });
    const sc = $('#styleChips');
    STYLES.forEach((s) => {
      const c = el('button', 'chip' + (s === this.style ? ' active' : ''), `${s.e} ${s.name}`);
      c.onclick = () => { sc.querySelectorAll('.chip').forEach((x) => x.classList.remove('active')); c.classList.add('active'); this.style = s; this.changed(true); };
      sc.appendChild(c);
    });
    $('#bpm').oninput = (e) => { this.bpm = +e.target.value; $('#bpmVal').textContent = this.bpm; this.changed(); };
    $('#trDown').onclick = () => { this.tr = Math.max(-12, this.tr - 1); this.changed(); };
    $('#trUp').onclick = () => { this.tr = Math.min(12, this.tr + 1); this.changed(); };
    $('#snap').onchange = (e) => { this.snap = e.target.checked; this.changed(); };
    $('#humPlay').onclick = () => this.togglePlay();
    $('#humCont').onclick = () => this.extend();
    $('#humUncont').onclick = () => { this.cont = []; this.changed(); };
    $('#humWav').onclick = () => this.exportWav(false);
    $('#humShare').onclick = () => this.exportWav(true);
    $('#humMidi').onclick = () => this.exportMidi();
    $('#humToVoice').onclick = () => {
      const a = this.input.audio; if (!a) return;
      Voice.input.set(a.x, a.sr); switchTab('voice'); toast('Запись перенесена — выбирай голос 🎭');
    };
  },

  async analyze(x, sr) {
    Player.stop();
    const res = await busy('Распознаю ноты…', async () => {
      const tr = DSP.yinTrack(x, sr);
      return DSP.segmentNotes(tr);
    });
    if (res.length < 3) {
      toast('Не удалось разобрать мелодию. Пой громче и чётче — на «ла» или «ду», без слов и шума', 4500);
      return;
    }
    this.raw = x; this.notes = res; this.cont = []; this.tr = 0;
    this.key = DSP.detectKey(res);
    this.bpmDetected = DSP.estimateBpm(res);
    this.bpm = this.bpmDetected;
    $('#bpm').value = this.bpm; $('#bpmVal').textContent = this.bpm;
    $('#humResult').hidden = false; $('#humHint').hidden = true;
    this.changed(true);
    setTimeout(() => $('#humResult').scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  },

  melody() {
    const mel = DSP.quantize(this.notes, this.bpmDetected, this.key, this.snap);
    if (!this.cont.length) return mel;
    const last = mel[mel.length - 1], startB = Math.ceil((last.b + last.d) / 4) * 4;
    return mel.concat(this.cont.map((n) => ({ b: n.b + startB, d: n.d, m: n.m, gen: true })));
  },

  build() {
    const key = { tonic: (this.key.tonic + this.tr + 12) % 12, mode: this.key.mode };
    key.name = DSP.NOTE_NAMES[key.tonic] + (key.mode === 'major' ? ' мажор' : ' минор');
    const mel = this.melody().map((n) => Object.assign({}, n, { m: n.m + this.tr }));
    const last = mel[mel.length - 1];
    const bars = Math.max(1, Math.ceil((last.b + last.d) / 4));
    const chords = DSP.chooseChords(mel, key, bars);
    this.arr = DSP.arrange(mel, chords, this.style, 1);
    this.arr.chords = chords; this.arr.key = key;
    $('#trVal').textContent = (this.tr > 0 ? '+' : '') + this.tr;
    const you = mel.filter((n) => !n.gen).length;
    $('#humInfo').innerHTML = `<span class="chip">🎼 ${key.name}</span><span class="chip">⏱ ${this.bpm} BPM</span><span class="chip">🎵 ${you} нот</span><span class="chip">📏 ${bars} так.</span>`;
    $('#humUncont').hidden = !this.cont.length;
    this.drawRoll();
  },

  changed(now) {
    if (!this.notes) return;
    if (Player.playing && this.isPlaying) Player.stop();
    this.build();
    this.dirty = true;
    clearTimeout(this._t);
    this._t = setTimeout(() => this.render(), now ? 10 : 350);
  },

  async render() {
    const id = ++this.renderId;
    const buf = await renderSong(this.arr, this.style, this.bpm);
    if (id !== this.renderId) return null;
    this.buffer = buf; this.dirty = false;
    return buf;
  },

  async togglePlay() {
    if (this.isPlaying) { Player.stop(); return; }
    let buf = this.buffer;
    if (this.dirty || !buf) buf = await busy('Собираю трек…', () => this.render());
    if (!buf) return;
    this.isPlaying = true;
    $('#humPlay').textContent = '⏹ Стоп';
    Player.play(buf, () => { this.isPlaying = false; $('#humPlay').textContent = '▶ Играть'; this.drawRoll(); });
    const tick = () => {
      if (!this.isPlaying) return;
      this.drawRoll(Player.pos() / (60 / this.bpm));
      requestAnimationFrame(tick);
    };
    tick();
  },

  extend() {
    if (!this.notes) return;
    if (this.cont.length && this.cont[this.cont.length - 1].b > 60) { toast('Хватит продолжений 🙂 Можно убрать и сгенерировать заново'); return; }
    const mel = this.melody();
    const last = mel.filter((n) => !n.gen).pop();
    const startB = Math.ceil((last.b + last.d) / 4) * 4;
    const more = DSP.continueMelody(mel, this.key, 4);
    more.forEach((n) => this.cont.push({ b: n.b - startB, d: n.d, m: n.m }));
    this.changed(true);
    toast('✨ Добавил 4 такта — нажми «Играть»');
  },

  async exportWav(share) {
    let buf = this.buffer;
    if (this.dirty || !buf) buf = await busy('Собираю трек…', () => this.render());
    if (!buf) return;
    const wav = DSP.toWav([buf.getChannelData(0), buf.getChannelData(1)], buf.sampleRate);
    saveFile(`melody_${this.style.id}_${stamp()}.wav`, wav, 'audio/wav', share);
  },
  exportMidi() {
    if (!this.arr) return;
    const mid = DSP.toMidi(this.arr, this.bpm, this.style.prog);
    saveFile(`melody_${this.style.id}_${stamp()}.mid`, mid, 'audio/midi', false);
  },

  drawRoll(playBeat) {
    const cv = $('#roll'), wrap = $('#rollWrap');
    if (!this.arr) return;
    const T = this.arr.tracks, total = this.arr.totalBeats;
    const lead = T.lead;
    const ppb = Math.max(30, (wrap.clientWidth - 4) / total);
    const W = Math.ceil(total * ppb), H = 230, laneH = 28;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px'; }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    let lo = 127, hi = 0; lead.forEach((n) => { lo = Math.min(lo, n.m); hi = Math.max(hi, n.m); });
    lo -= 2; hi += 2; if (hi - lo < 12) { const c = (hi + lo) / 2; lo = Math.floor(c - 6); hi = Math.ceil(c + 6); }
    const rowH = (H - laneH - 8) / (hi - lo + 1);
    const y = (m) => 4 + (hi - m) * rowH;
    // фон тактов
    const bars = total / 4;
    for (let b = 0; b < bars; b++) {
      const isIntro = b === 0, isOutro = b === bars - 1;
      g.fillStyle = isIntro || isOutro ? 'rgba(255,255,255,0.015)' : (b % 2 ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.02)');
      g.fillRect(b * 4 * ppb, 0, 4 * ppb, H);
      g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(b * 4 * ppb, 0, 1, H);
      for (let q = 1; q < 4; q++) { g.fillStyle = 'rgba(255,255,255,0.04)'; g.fillRect((b * 4 + q) * ppb, 0, 1, H - laneH); }
    }
    // строки «до»
    for (let m = lo; m <= hi; m++) if (m % 12 === 0) { g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(0, y(m) + rowH - 1, W, 1); }
    // аккорды
    g.font = '600 12px system-ui'; g.textBaseline = 'middle';
    const ch = this.arr.chords || [];
    for (let b = 0; b < bars; b++) {
      const c = b === 0 ? ch[0] : (b - 1 < ch.length ? ch[b - 1] : null);
      g.fillStyle = 'rgba(139,92,246,0.18)';
      g.fillRect(b * 4 * ppb + 3, H - laneH + 3, 4 * ppb - 6, laneH - 6);
      g.fillStyle = '#d9ccff';
      const label = b === 0 ? 'вступ.' : (b === bars - 1 ? 'финал' : (c ? DSP.chordName(c) : ''));
      g.fillText(label, b * 4 * ppb + 9, H - laneH / 2);
    }
    // ноты
    lead.forEach((n) => {
      const x0 = n.b * ppb + 1, w = Math.max(4, n.d * ppb - 2), y0 = y(n.m) + 1, h = Math.max(4, rowH - 2);
      const hue = ((n.m % 12) * 30 + 320) % 360;
      g.beginPath();
      if (g.roundRect) g.roundRect(x0, y0, w, h, Math.min(5, h / 2)); else g.rect(x0, y0, w, h);
      if (n.gen) { g.setLineDash([4, 3]); g.strokeStyle = '#22d3ee'; g.lineWidth = 1.5; g.fillStyle = 'rgba(34,211,238,0.18)'; g.fill(); g.stroke(); g.setLineDash([]); }
      else { g.fillStyle = `hsl(${hue},85%,62%)`; g.fill(); }
      if (w > 22 && h > 11) {
        g.fillStyle = n.gen ? '#bdf4ff' : 'rgba(20,10,40,0.85)'; g.font = '600 10px system-ui';
        g.fillText(DSP.NOTE_NAMES[n.m % 12].replace('♯', '#'), x0 + 4, y0 + h / 2 + 0.5);
      }
    });
    if (playBeat != null && playBeat >= 0) {
      const px = playBeat * ppb;
      g.fillStyle = '#fff'; g.fillRect(px, 0, 2, H);
      if (px > wrap.scrollLeft + wrap.clientWidth * 0.7 || px < wrap.scrollLeft) wrap.scrollLeft = px - wrap.clientWidth * 0.3;
    }
  }
};

async function renderSong(arr, style, bpm) {
  const spb = 60 / bpm, sr = 44100;
  const dur = arr.totalBeats * spb + 2.5;
  const c = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
  comp.connect(c.destination);
  let pre = c.createGain(); pre.gain.value = 0.8;
  if (style.lp) { const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = style.lp; pre.connect(lp); lp.connect(comp); } else pre.connect(comp);
  const rv = c.createConvolver(); rv.buffer = Synth.impulse(c, 2.4, 3);
  const send = c.createGain(); send.gain.value = style.reverb || 0.15; send.connect(rv); rv.connect(pre);
  const bus = (vol, pan) => {
    const g = c.createGain(); g.gain.value = vol;
    const p = c.createStereoPanner(); p.pan.value = pan;
    g.connect(p); p.connect(pre); p.connect(send);
    return g;
  };
  const leadB = bus(0.9, 0), chB = bus(0.55, -0.12), bassB = bus(0.75, 0.05), drB = bus(0.8, 0);
  const t0 = 0.05, T = arr.tracks;
  T.lead.forEach((n) => Synth.I[style.lead](c, leadB, n.m, t0 + n.b * spb, n.d * spb, n.v));
  T.chords.forEach((n) => Synth.I[style.ch](c, chB, n.m, t0 + n.b * spb, n.d * spb, n.v));
  T.bass.forEach((n) => Synth.I[style.bassI](c, bassB, n.m, t0 + n.b * spb, n.d * spb, n.v));
  T.drums.forEach((n) => Synth.D[n.k] && Synth.D[n.k](c, drB, t0 + n.b * spb, n.v));
  if (style.pump) {
    const G = chB.gain;
    for (let b = 0; b < arr.totalBeats - 4; b++) { const t = t0 + b * spb; G.setValueAtTime(0.12, t); G.linearRampToValueAtTime(0.55, t + spb * 0.6); }
  }
  if (style.crackle) {
    const n = Math.floor(dur * 9);
    for (let i = 0; i < n; i++) {
      const t = Math.random() * dur, s = c.createBufferSource(); s.buffer = Synth.noiseBuf(c);
      const g = c.createGain(); g.gain.setValueAtTime(0.03 + Math.random() * 0.05, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.004);
      s.connect(g); g.connect(comp); s.start(t, Math.random()); s.stop(t + 0.01);
    }
    const hiss = c.createBufferSource(); hiss.buffer = Synth.noiseBuf(c); hiss.loop = true;
    const hl = c.createBiquadFilter(); hl.type = 'lowpass'; hl.frequency.value = 2500;
    const hg = c.createGain(); hg.gain.value = 0.006; hiss.connect(hl); hl.connect(hg); hg.connect(comp); hiss.start(0);
  }
  const out = await c.startRendering();
  let pk = 0;
  for (let ch = 0; ch < 2; ch++) { const d = out.getChannelData(ch); for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i])); }
  if (pk > 0) { const g = 0.92 / pk; for (let ch = 0; ch < 2; ch++) { const d = out.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] *= g; } }
  return out;
}

// ===================== вкладка «Голоса» =====================
// граф эффектов в OfflineAudioContext
async function offline(x, sr, opts, build) {
  const rate = opts.rate || 1, tail = opts.tail == null ? 0.6 : opts.tail;
  const len = Math.ceil(x.length / rate + tail * sr);
  const c = new OfflineAudioContext(1, len, sr);
  const b = c.createBuffer(1, x.length, sr); b.copyToChannel(x, 0);
  const s = c.createBufferSource(); s.buffer = b; s.playbackRate.value = rate;
  const out = build ? build(c, s) : s;
  out.connect(c.destination);
  s.start(0);
  const r = await c.startRendering();
  return Float32Array.from(r.getChannelData(0));
}
const fx = (x, sr, build, opts = {}) => offline(x, sr, opts, build);

const N = {
  filt(c, n, type, f, q = 0.7, gain = 0) { const b = c.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = gain; n.connect(b); return b; },
  hp: (c, n, f) => N.filt(c, n, 'highpass', f),
  lp: (c, n, f) => N.filt(c, n, 'lowpass', f),
  band: (c, n, lo, hi) => N.lp(c, N.hp(c, n, lo), hi),
  peak: (c, n, f, gain, q = 1) => N.filt(c, n, 'peaking', f, q, gain),
  gain(c, n, v) { const g = c.createGain(); g.gain.value = v; n.connect(g); return g; },
  dist(c, n, amt) { const ws = Synth.shaper(c, amt); n.connect(ws); return N.gain(c, ws, 0.8); },
  mix(c, dry, wet, m) { const o = c.createGain(); N.gain(c, dry, 1 - m * 0.5).connect(o); N.gain(c, wet, m).connect(o); return o; },
  rev(c, n, sec, m, decay = 2.5) { const cv = c.createConvolver(); cv.buffer = Synth.impulse(c, sec, decay, 1); n.connect(cv); return N.mix(c, n, cv, m); },
  delay(c, n, time, fb, m, lpf = 3500) {
    const d = c.createDelay(5); d.delayTime.value = time;
    const f = c.createGain(); f.gain.value = fb;
    const l = c.createBiquadFilter(); l.type = 'lowpass'; l.frequency.value = lpf;
    n.connect(d); d.connect(l); l.connect(f); f.connect(d);
    return N.mix(c, n, l, m);
  },
  ring(c, n, freq, m) {
    const g = c.createGain(); g.gain.value = 0;
    const o = c.createOscillator(); o.frequency.value = freq; o.connect(g.gain); o.start();
    n.connect(g);
    return N.mix(c, n, g, m);
  },
  trem(c, n, rate, depth) {
    const g = c.createGain(); g.gain.value = 1 - depth / 2;
    const o = c.createOscillator(), og = c.createGain(); o.frequency.value = rate; og.gain.value = depth / 2;
    o.connect(og); og.connect(g.gain); o.start(); n.connect(g); return g;
  },
  comb(c, n, ms, fb) {
    const d = c.createDelay(0.1); d.delayTime.value = ms / 1000;
    const f = c.createGain(); f.gain.value = fb;
    n.connect(d); d.connect(f); f.connect(d);
    const o = c.createGain(); n.connect(o); N.gain(c, d, 0.7).connect(o); return o;
  }
};

// вспомогательные звуки
function tone(sr, f, sec, vol = 0.4, decay = 6) {
  const n = Math.floor(sr * sec), y = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / sr; y[i] = Math.sin(2 * Math.PI * f * t) * vol * Math.exp(-t * decay) * Math.min(1, t * 200); }
  return y;
}
function noise(sr, sec, vol) { const n = Math.floor(sr * sec), y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = (Math.random() * 2 - 1) * vol * (1 - i / n); return y; }
function cat(...arr) { const n = arr.reduce((a, b) => a + b.length, 0), y = new Float32Array(n); let o = 0; arr.forEach((a) => { y.set(a, o); o += a.length; }); return y; }
function silence(sr, sec) { return new Float32Array(Math.floor(sr * sec)); }
function addInto(y, a, gain = 1, offset = 0) { for (let i = 0; i < a.length && i + offset < y.length; i++) y[i + offset] += a[i] * gain; return y; }
function chime(sr) {
  const parts = [[72, 0], [76, 0.32], [79, 0.64]];
  const y = new Float32Array(Math.floor(sr * 1.7));
  parts.forEach(([m, t]) => { addInto(y, tone(sr, mtof(m), 1.1, 0.3, 3), 1, Math.floor(t * sr)); addInto(y, tone(sr, mtof(m) * 2, 0.6, 0.08, 6), 1, Math.floor(t * sr)); });
  return y;
}
const wob = (sr, base, depth, rate) => (n) => base * (1 + depth * Math.sin(2 * Math.PI * rate * n / sr));

const CATS = [
  { id: 'all', n: 'Все' }, { id: 'fun', n: '😂 Смешные' }, { id: 'scary', n: '👻 Страшные' }, { id: 'robot', n: '🤖 Роботы' },
  { id: 'music', n: '🎵 Музыка' }, { id: 'comms', n: '📻 Связь' }, { id: 'places', n: '🏔 Места' }
];
const CAT_COL = { fun: '#f59e0b', scary: '#ef4444', robot: '#06b6d4', music: '#ec4899', comms: '#22c55e', places: '#8b5cf6' };

const VOICES = [
  { n: 'Обычный', e: '🙂', c: 'fun', p: async (x) => x },
  { n: 'Гелий', e: '🎈', c: 'fun', p: async (x, sr) => DSP.pitchShift(x, sr, 1.7, 30) },
  { n: 'Мышка', e: '🐭', c: 'fun', p: (x, sr) => fx(DSP.pitchShift(x, sr, 2.1, 25), sr, (c, n) => N.hp(c, n, 300)) },
  { n: 'Бурундук', e: '🐿️', c: 'fun', p: (x, sr) => fx(x, sr, null, { rate: 1.6, tail: 0 }) },
  { n: 'Ребёнок', e: '👶', c: 'fun', p: (x, sr) => fx(DSP.pitchShift(x, sr, 1.33, 35), sr, (c, n) => N.peak(c, N.hp(c, n, 200), 3200, 4)) },
  { n: 'Старичок', e: '👴', c: 'fun', p: (x, sr) => fx(DSP.pitchShift(x, sr, wob(sr, 0.9, 0.025, 6)), sr, (c, n) => N.trem(c, N.band(c, n, 180, 3500), 6.5, 0.35)) },
  { n: 'Пьяный', e: '🥴', c: 'fun', p: (x, sr) => fx(DSP.pitchShift(x, sr, wob(sr, 0.92, 0.07, 0.6), 50), sr, (c, n) => N.lp(c, n, 3000)) },
  { n: 'Замедленно', e: '🐢', c: 'fun', p: (x, sr) => fx(x, sr, null, { rate: 0.68, tail: 0 }) },
  { n: 'Задом наперёд', e: '⏪', c: 'fun', p: async (x) => DSP.reverse(x) },
  { n: 'Великан', e: '🗿', c: 'scary', p: (x, sr) => fx(DSP.pitchShift(x, sr, 0.68, 45), sr, (c, n) => N.rev(c, N.peak(c, n, 150, 5), 1.2, 0.2)) },
  { n: 'Монстр', e: '👹', c: 'scary', p: (x, sr) => fx(DSP.pitchShift(x, sr, 0.55, 50), sr, (c, n) => N.ring(c, N.lp(c, N.dist(c, n, 12), 1800), 28, 0.25)) },
  { n: 'Демон', e: '😈', c: 'scary', p: (x, sr) => {
    const y = DSP.pitchShift(x, sr, 0.5, 55); addInto(y, DSP.pitchShift(x, sr, 0.75, 45), 0.5); addInto(y, x, 0.2);
    return fx(DSP.normalize(y, 0.8), sr, (c, n) => N.rev(c, N.lp(c, N.dist(c, n, 5), 2500), 2.8, 0.4), { tail: 2 });
  } },
  { n: 'Зомби', e: '🧟', c: 'scary', p: (x, sr) => fx(DSP.pitchShift(x, sr, wob(sr, 0.7, 0.04, 1.3), 50), sr, (c, n) => N.lp(c, N.dist(c, N.peak(c, n, 700, 6, 2), 20), 1500)) },
  { n: 'Призрак', e: '👻', c: 'scary', p: async (x, sr) => {
    const pad = cat(silence(sr, 1.5), x);
    const wet = await fx(DSP.reverse(pad), sr, (c, n) => { const cv = c.createConvolver(); cv.buffer = Synth.impulse(c, 3, 2, 1); n.connect(cv); return cv; }, { tail: 3 });
    const swell = DSP.normalize(DSP.reverse(wet), 0.6);
    const dry = cat(silence(sr, Math.max(0, swell.length - x.length) / sr), DSP.pitchShift(x, sr, 0.92));
    addInto(swell, dry, 0.7);
    return fx(swell, sr, (c, n) => N.rev(c, N.hp(c, n, 300), 2.5, 0.3), { tail: 2 });
  } },
  { n: 'Кукла', e: '🪆', c: 'scary', p: (x, sr) => fx(DSP.bitcrush(DSP.pitchShift(x, sr, 1.4, 30), 8, 2), sr, (c, n) => N.rev(c, N.trem(c, n, 7, 0.4), 1.6, 0.3), { tail: 1.5 }) },
  { n: 'Шёпот', e: '🤫', c: 'scary', p: (x, sr) => fx(DSP.vocoder(x, sr, DSP.makeCarrier(x.length, sr, 'noise')), sr, (c, n) => N.rev(c, N.hp(c, n, 400), 1.2, 0.2)) },
  { n: 'Тёмный лорд', e: '🦹', c: 'scary', p: (x, sr) => fx(DSP.pitchShift(x, sr, 0.78, 45), sr, (c, n) => N.rev(c, N.dist(c, N.comb(c, N.lp(c, n, 2600), 12, 0.35), 3), 1, 0.2)) },
  { n: 'Робот', e: '🤖', c: 'robot', p: (x, sr) => fx(x, sr, (c, n) => N.comb(c, N.ring(c, n, 55, 0.75), 6, 0.55)) },
  { n: 'Большой робот', e: '🦾', c: 'robot', p: (x, sr) => fx(DSP.pitchShift(x, sr, 0.72, 45), sr, (c, n) => N.rev(c, N.comb(c, N.ring(c, n, 32, 0.6), 9, 0.65), 1.3, 0.2)) },
  { n: 'Синтезатор речи', e: '📟', c: 'robot', p: async (x, sr) => DSP.vocoder(x, sr, DSP.makeCarrier(x.length, sr, 'saw', 105)) },
  { n: 'Киборг', e: '🧬', c: 'robot', p: async (x, sr) => {
    const f = DSP.pitchPerSample(x, sr).perSample;
    return DSP.vocoder(x, sr, DSP.makeCarrier(x.length, sr, 'saw', Array.from(f)));
  } },
  { n: 'Хор роботов', e: '🎛️', c: 'robot', p: (x, sr) => fx(DSP.vocoder(x, sr, DSP.makeCarrier(x.length, sr, 'saw', [110, 138.6, 164.8, 220])), sr, (c, n) => N.rev(c, n, 2, 0.3), { tail: 1.5 }) },
  { n: 'Инопланетянин', e: '👽', c: 'robot', p: (x, sr) => fx(DSP.pitchShift(x, sr, wob(sr, 1.3, 0.05, 8), 30), sr, (c, n) => N.delay(c, N.ring(c, n, 600, 0.25), 0.12, 0.3, 0.25), { tail: 1 }) },
  { n: 'Автотюн', e: '🎤', c: 'music', p: (x, sr) => fx(DSP.autotune(x, sr, { smooth: 0.05 }), sr, (c, n) => N.rev(c, n, 1.5, 0.15)) },
  { n: 'Поющее трио', e: '🎶', c: 'music', p: (x, sr) => {
    const a = DSP.autotune(x, sr, { smooth: 0.1 });
    const y = Float32Array.from(a); addInto(y, DSP.pitchShift(a, sr, Math.pow(2, 4 / 12)), 0.6); addInto(y, DSP.pitchShift(a, sr, Math.pow(2, 7 / 12)), 0.5);
    return fx(DSP.normalize(y, 0.8), sr, (c, n) => N.rev(c, n, 2, 0.2), { tail: 1.5 });
  } },
  { n: 'Хор', e: '⛪', c: 'music', p: (x, sr) => {
    const y = Float32Array.from(x);
    addInto(y, DSP.pitchShift(x, sr, 1.007), 0.6, Math.floor(sr * 0.018));
    addInto(y, DSP.pitchShift(x, sr, 0.993), 0.6, Math.floor(sr * 0.027));
    addInto(y, DSP.pitchShift(x, sr, 0.5, 50), 0.4, Math.floor(sr * 0.012));
    addInto(y, DSP.pitchShift(x, sr, 2, 25), 0.15);
    return fx(DSP.normalize(y, 0.8), sr, (c, n) => N.rev(c, n, 3.2, 0.45), { tail: 3 });
  } },
  { n: '8-бит', e: '🕹️', c: 'music', p: (x, sr) => fx(DSP.bitcrush(DSP.autotune(x, sr, { smooth: 0 }), 4, 6), sr, (c, n) => N.lp(c, N.hp(c, n, 200), 6000)) },
  { n: 'Телефон', e: '📞', c: 'comms', p: (x, sr) => fx(x, sr, (c, n) => N.dist(c, N.band(c, n, 350, 3400), 4)) },
  { n: 'Рация', e: '📻', c: 'comms', p: async (x, sr) => {
    const y = await fx(x, sr, (c, n) => N.dist(c, N.band(c, n, 500, 2600), 25), { tail: 0 });
    addInto(y, noise(sr, y.length / sr, 0.02));
    return cat(noise(sr, 0.18, 0.35), y, noise(sr, 0.35, 0.4));
  } },
  { n: 'Космонавт', e: '🧑‍🚀', c: 'comms', p: async (x, sr) => {
    const y = await fx(x, sr, (c, n) => N.rev(c, N.dist(c, N.band(c, n, 400, 3000), 6), 0.8, 0.15), { tail: 0.3 });
    return cat(tone(sr, 2525, 0.25, 0.35, 0), silence(sr, 0.15), y, tone(sr, 2475, 0.25, 0.35, 0));
  } },
  { n: 'Старое радио', e: '📼', c: 'comms', p: async (x, sr) => {
    const y = await fx(DSP.pitchShift(x, sr, wob(sr, 1, 0.006, 0.8)), sr, (c, n) => N.dist(c, N.band(c, n, 450, 3000), 6), { tail: 0.2 });
    for (let i = 0; i < y.length; i++) if (Math.random() < 0.0004) y[i] += (Math.random() - 0.5) * 0.8;
    addInto(y, noise(sr, y.length / sr, 0.012));
    return y;
  } },
  { n: 'Мегафон', e: '📢', c: 'comms', p: (x, sr) => fx(x, sr, (c, n) => N.delay(c, N.peak(c, N.dist(c, N.band(c, n, 700, 3200), 40), 1800, 6), 0.09, 0.2, 0.25), { tail: 0.8 }) },
  { n: 'Диктор на вокзале', e: '🚉', c: 'places', p: async (x, sr) => {
    const y = await fx(cat(chime(sr), x), sr, (c, n) => N.delay(c, N.rev(c, N.band(c, n, 300, 4500), 3.5, 0.5), 0.3, 0.25, 0.2), { tail: 3 });
    return y;
  } },
  { n: 'Пещера', e: '🕳️', c: 'places', p: (x, sr) => fx(x, sr, (c, n) => N.rev(c, N.delay(c, n, 0.22, 0.45, 0.4, 2500), 4, 0.45), { tail: 4 }) },
  { n: 'Стадион', e: '🏟️', c: 'places', p: (x, sr) => fx(x, sr, (c, n) => N.rev(c, N.delay(c, N.hp(c, n, 150), 0.45, 0.25, 0.3), 3, 0.5), { tail: 3.5 }) },
  { n: 'Эхо в горах', e: '🏔️', c: 'places', p: (x, sr) => fx(x, sr, (c, n) => N.delay(c, n, 0.7, 0.5, 0.55, 2000), { tail: 5 }) },
  { n: 'Под водой', e: '🌊', c: 'places', p: (x, sr) => fx(DSP.pitchShift(x, sr, wob(sr, 1, 0.03, 3)), sr, (c, n) => N.rev(c, N.lp(c, n, 450), 1.5, 0.3), { tail: 1.5 }) },
  { n: 'В ванной', e: '🛁', c: 'places', p: (x, sr) => fx(x, sr, (c, n) => N.rev(c, N.peak(c, n, 400, 3), 1.1, 0.5, 1.5), { tail: 1.2 }) }
];

const CUSTOM = {
  sliders: [
    { id: 'pitch', n: 'Высота', min: -12, max: 12, step: 1, v: 0, f: (v) => (v > 0 ? '+' : '') + v },
    { id: 'speed', n: 'Скорость', min: 0.5, max: 2, step: 0.05, v: 1, f: (v) => '×' + (+v).toFixed(2) },
    { id: 'robot', n: 'Робот', min: 0, max: 1, step: 0.05, v: 0, f: (v) => Math.round(v * 100) + '%' },
    { id: 'echo', n: 'Эхо', min: 0, max: 1, step: 0.05, v: 0, f: (v) => Math.round(v * 100) + '%' },
    { id: 'reverb', n: 'Зал', min: 0, max: 1, step: 0.05, v: 0, f: (v) => Math.round(v * 100) + '%' },
    { id: 'dist', n: 'Искажение', min: 0, max: 1, step: 0.05, v: 0, f: (v) => Math.round(v * 100) + '%' },
    { id: 'wobble', n: 'Дрожание', min: 0, max: 1, step: 0.05, v: 0, f: (v) => Math.round(v * 100) + '%' }
  ],
  toggles: [
    { id: 'tune', n: '🎤 Автотюн' }, { id: 'phone', n: '📞 Телефон' }, { id: 'rev', n: '⏪ Задом' }, { id: 'under', n: '🌊 Под водой' }
  ],
  st: {},
  async process(x, sr) {
    const s = this.st;
    let y = x;
    if (s.rev) y = DSP.reverse(y);
    if (s.tune) y = DSP.autotune(y, sr, { smooth: 0.08 });
    const r = Math.pow(2, s.pitch / 12);
    if (s.pitch !== 0 || s.wobble > 0) y = DSP.pitchShift(y, sr, s.wobble > 0 ? wob(sr, r, s.wobble * 0.06, 5) : r, r < 1 ? 45 : 35);
    return fx(y, sr, (c, n) => {
      if (s.phone) n = N.band(c, n, 350, 3400);
      if (s.under) n = N.lp(c, n, 500);
      if (s.dist > 0) n = N.dist(c, n, 1 + s.dist * 30);
      if (s.robot > 0) n = N.comb(c, N.ring(c, n, 50, s.robot), 6, 0.5 * s.robot);
      if (s.echo > 0) n = N.delay(c, n, 0.32, 0.25 + s.echo * 0.4, s.echo * 0.6);
      if (s.reverb > 0) n = N.rev(c, n, 1 + s.reverb * 3, s.reverb * 0.6);
      return n;
    }, { rate: s.speed, tail: s.echo > 0 || s.reverb > 0 ? 3 : 0.3 });
  }
};

const Voice = {
  cat: 'all', active: null, cache: new Map(), result: null,
  init() {
    this.input = makeInput($('#voiceInput'), {
      title: 'Запиши голос', sub: 'Скажи что-нибудь — потом выбери эффект ниже',
      onAudio: () => { this.cache.clear(); this.stop(); toast('Готово! Нажимай на голоса 👇'); }
    });
    const cc = $('#catChips');
    CATS.forEach((ct) => {
      const b = el('button', 'chip' + (ct.id === this.cat ? ' active' : ''), ct.n);
      b.onclick = () => { cc.querySelectorAll('.chip').forEach((x) => x.classList.remove('active')); b.classList.add('active'); this.cat = ct.id; this.renderGrid(); };
      cc.appendChild(b);
    });
    this.renderGrid();
    // конструктор
    const sl = $('#sliders');
    CUSTOM.sliders.forEach((s) => {
      CUSTOM.st[s.id] = s.v;
      const w = el('div', 'sl', `<div class="label"><span>${s.n}</span><i>${s.f(s.v)}</i></div><input type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${s.v}">`);
      w.querySelector('input').oninput = (e) => { CUSTOM.st[s.id] = +e.target.value; w.querySelector('i').textContent = s.f(+e.target.value); };
      sl.appendChild(w);
    });
    CUSTOM.toggles.forEach((t) => {
      CUSTOM.st[t.id] = false;
      const b = el('button', 'chip', t.n);
      b.onclick = () => { CUSTOM.st[t.id] = !CUSTOM.st[t.id]; b.classList.toggle('active', CUSTOM.st[t.id]); };
      $('#toggles').appendChild(b);
    });
    $('#sheetClose').onclick = () => { $('#sheet').hidden = true; };
    $('#sheet').onclick = (e) => { if (e.target.id === 'sheet') $('#sheet').hidden = true; };
    $('#customPlay').onclick = async () => {
      const a = this.need(); if (!a) return;
      const y = await busy('Собираю твой голос…', () => CUSTOM.process(a.x, a.sr));
      $('#sheet').hidden = true;
      this.play({ n: 'Свой голос', e: '🎛' }, y, a.sr, null);
    };
    $('#vbPlay').onclick = () => {
      if (Player.playing && this.isPlaying) this.stop();
      else if (this.result) this.play(this.result.v, this.result.y, this.result.sr, this.result.card);
    };
    $('#vbSave').onclick = () => this.save(false);
    $('#vbShare').onclick = () => this.save(true);
  },
  need() {
    const a = this.input.audio;
    if (!a) { toast('Сначала запиши голос — нажми на микрофон 🎙'); window.scrollTo({ top: 0, behavior: 'smooth' }); return null; }
    return a;
  },
  renderGrid() {
    const g = $('#voiceGrid'); g.innerHTML = '';
    if (this.cat === 'all') {
      const cst = el('button', 'vcard custom', `<div class="em" style="background:linear-gradient(135deg,#ff4f9a,#8b5cf6)">🎛</div><div class="nm">Свой голос</div>`);
      cst.onclick = () => { $('#sheet').hidden = false; };
      g.appendChild(cst);
    }
    VOICES.filter((v) => this.cat === 'all' || v.c === this.cat).forEach((v) => {
      const card = el('button', 'vcard', `<div class="em" style="background:${CAT_COL[v.c]}33">${v.e}</div><div class="nm">${v.n}</div>`);
      if (this.active === v.n) card.classList.add('active');
      card.onclick = () => this.pick(v, card);
      g.appendChild(card);
    });
  },
  async pick(v, card) {
    const a = this.need(); if (!a) return;
    if (this.active === v.n && this.isPlaying) { this.stop(); return; }
    let y = this.cache.get(v.n);
    if (!y) {
      try { y = await busy(`${v.e} ${v.n}…`, () => v.p(a.x, a.sr)); }
      catch (e) { console.error(e); toast('Ошибка обработки: ' + e.message); return; }
      y = DSP.normalize(Float32Array.from(y), 0.9);
      this.cache.set(v.n, y);
    }
    this.play(v, y, a.sr, card);
  },
  play(v, y, sr, card) {
    Player.stop();
    document.querySelectorAll('.vcard.active').forEach((c) => c.classList.remove('active'));
    this.active = v.n; if (card) card.classList.add('active');
    this.result = { v, y, sr, card };
    $('#vbar').hidden = false; $('#vbName').textContent = `${v.e} ${v.n}`; $('#vbPlay').textContent = '⏹';
    this.isPlaying = true;
    Player.play(toBuffer([y], sr), () => {
      this.isPlaying = false; $('#vbPlay').textContent = '▶';
      if (card) card.classList.remove('active');
      this.active = null;
    });
  },
  stop() { if (this.isPlaying) Player.stop(); },
  save(share) {
    if (!this.result) return;
    const { v, y, sr } = this.result;
    const name = `voice_${VOICES.indexOf(v) >= 0 ? VOICES.indexOf(v) : 'custom'}_${stamp()}.wav`;
    saveFile(name, DSP.toWav([y], sr), 'audio/wav', share);
  }
};

// ===================== вкладки =====================
function switchTab(id) {
  Player.stop();
  document.querySelectorAll('.tabbtn').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + id));
  $('#tabTitle').textContent = id === 'hum' ? 'Напой — получи трек' : '37 голосов и свой конструктор';
  $('#vbar').hidden = id !== 'voice' || !Voice.result;
  window.scrollTo(0, 0);
  document.querySelectorAll('.wave').forEach((w) => { if (w._x) drawWave(w, w._x); });
  if (id === 'hum' && Hum.arr) setTimeout(() => Hum.drawRoll(), 50);
}
document.querySelectorAll('.tabbtn').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });
window.onAndroidBack = () => {
  if (!$('#sheet').hidden) { $('#sheet').hidden = true; return true; }
  if (document.querySelector('.tabbtn.active').dataset.tab !== 'hum') { switchTab('hum'); return true; }
  return false;
};
window.addEventListener('resize', () => { if (Hum.arr) Hum.drawRoll(); });

Hum.init();
Voice.init();
