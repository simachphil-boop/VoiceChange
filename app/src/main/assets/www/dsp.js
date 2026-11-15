// ===== DSP: распознавание мелодии, гармония, эффекты голоса =====
(function (G) {
  const DSP = {};
  const NOTE_NAMES = ['До', 'До♯', 'Ре', 'Ми♭', 'Ми', 'Фа', 'Фа♯', 'Соль', 'Ля♭', 'Ля', 'Си♭', 'Си'];
  const LAT = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  DSP.NOTE_NAMES = NOTE_NAMES;
  DSP.LAT = LAT;

  const median = (a) => {
    if (!a.length) return NaN;
    const s = Array.from(a).sort((x, y) => x - y);
    const h = s.length >> 1;
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  };
  DSP.median = median;
  const pc = (m) => ((Math.round(m) % 12) + 12) % 12;

  // ---------- базовые операции ----------
  DSP.resample = function (x, srIn, srOut) {
    if (srIn === srOut) return Float32Array.from(x);
    const ratio = srIn / srOut;
    let src = x;
    if (ratio > 1.01) { // простой ФНЧ скользящим средним
      const k = Math.max(1, Math.round(ratio));
      src = new Float32Array(x.length);
      let acc = 0;
      for (let i = 0; i < x.length; i++) {
        acc += x[i];
        if (i >= k) acc -= x[i - k];
        src[i] = acc / Math.min(i + 1, k);
      }
    }
    const n = Math.floor(x.length / ratio);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * ratio, i0 = Math.floor(p), f = p - i0;
      const a = src[i0] || 0, b = src[i0 + 1] || 0;
      y[i] = a + (b - a) * f;
    }
    return y;
  };

  DSP.normalize = function (x, peak = 0.95) {
    let m = 0;
    for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > m) m = v; }
    if (m < 1e-9) return x;
    const g = peak / m;
    for (let i = 0; i < x.length; i++) x[i] *= g;
    return x;
  };

  DSP.trimSilence = function (x, sr) {
    const win = Math.round(sr * 0.02);
    let peak = 0;
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
    const thr = peak * 0.04;
    let s = 0, e = x.length;
    for (let i = 0; i < x.length; i += win) {
      let m = 0; for (let j = i; j < Math.min(i + win, x.length); j++) m = Math.max(m, Math.abs(x[j]));
      if (m > thr) { s = Math.max(0, i - win * 4); break; }
    }
    for (let i = x.length - win; i > 0; i -= win) {
      let m = 0; for (let j = i; j < Math.min(i + win, x.length); j++) m = Math.max(m, Math.abs(x[j]));
      if (m > thr) { e = Math.min(x.length, i + win * 8); break; }
    }
    return e > s ? x.slice(s, e) : x;
  };

  DSP.reverse = (x) => Float32Array.from(x).reverse();

  // ---------- YIN: высота голоса по кадрам ----------
  DSP.yinTrack = function (x, sr) {
    const aSr = 11025;
    const y = DSP.resample(x, sr, aSr);
    const W = 384, hop = 128, tauMin = Math.floor(aSr / 1100), tauMax = Math.ceil(aSr / 65);
    const n = Math.max(0, Math.floor((y.length - W - tauMax) / hop) + 1);
    const f0 = new Float32Array(n), rms = new Float32Array(n), conf = new Float32Array(n);
    const d = new Float32Array(tauMax + 2), cm = new Float32Array(tauMax + 2);
    for (let fi = 0; fi < n; fi++) {
      const o = fi * hop;
      let e = 0;
      for (let j = 0; j < W; j++) e += y[o + j] * y[o + j];
      rms[fi] = Math.sqrt(e / W);
      d[0] = 0; cm[0] = 1;
      let run = 0;
      for (let tau = 1; tau <= tauMax; tau++) {
        let s = 0;
        for (let j = 0; j < W; j++) { const df = y[o + j] - y[o + j + tau]; s += df * df; }
        d[tau] = s; run += s;
        cm[tau] = run > 0 ? s * tau / run : 1;
      }
      let tau = -1;
      for (let t = tauMin; t <= tauMax; t++) {
        if (cm[t] < 0.15) {
          while (t + 1 <= tauMax && cm[t + 1] < cm[t]) t++;
          tau = t; break;
        }
      }
      if (tau < 0) { f0[fi] = 0; conf[fi] = 0; continue; }
      let bt = tau;
      if (tau > 1 && tau < tauMax) {
        const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1];
        const den = a + c - 2 * b;
        if (Math.abs(den) > 1e-12) bt = tau + 0.5 * (a - c) / den;
      }
      f0[fi] = aSr / bt;
      conf[fi] = 1 - cm[tau];
    }
    // отсекаем тишину
    const sorted = Array.from(rms).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const thr = Math.max(0.004, p95 * 0.1);
    for (let i = 0; i < n; i++) if (rms[i] < thr) f0[i] = 0;
    return { f0, rms, conf, hop, sr: aSr, W, frameDur: hop / aSr, offset: W / 2 / aSr };
  };

  // ---------- кадры → ноты ----------
  DSP.segmentNotes = function (tr) {
    const n = tr.f0.length;
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) raw[i] = tr.f0[i] > 0 ? 69 + 12 * Math.log2(tr.f0[i] / 440) : NaN;
    // медианный фильтр по 5 кадрам + исправление октавных скачков
    const midi = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (isNaN(raw[i])) { midi[i] = NaN; continue; }
      const w = [];
      for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) if (!isNaN(raw[j])) w.push(raw[j]);
      let m = median(w);
      midi[i] = m;
    }
    const notes = [];
    let cur = null, gap = 0, cand = [];
    const close = () => {
      if (!cur) return;
      const len = cur.end - cur.start + 1;
      if (len >= 5) {
        const core = cur.vals.slice(Math.floor(cur.vals.length * 0.15), Math.ceil(cur.vals.length * 0.9));
        notes.push({ t: tr.offset + cur.start * tr.frameDur, d: len * tr.frameDur, p: median(core.length ? core : cur.vals) });
      }
      cur = null; cand = [];
    };
    for (let i = 0; i < n; i++) {
      const m = midi[i];
      if (isNaN(m)) {
        if (cur) { gap++; if (gap >= 3) close(); }
        continue;
      }
      if (cur && gap > 0 && gap < 3) cur.end = i - 1;
      gap = 0;
      if (!cur) { cur = { start: i, end: i, vals: [m] }; cand = []; continue; }
      const ref = median(cur.vals.slice(-8));
      // повторная атака на той же ноте (всплеск громкости)
      const r0 = tr.rms[Math.max(0, i - 4)];
      if (i - cur.start > 8 && r0 > 0 && tr.rms[i] / r0 > 2.4) { close(); cur = { start: i, end: i, vals: [m] }; continue; }
      if (Math.abs(m - ref) > 0.75) cand.push(i); else cand = [];
      cur.vals.push(m); cur.end = i;
      if (cand.length >= 4) {
        const k = cand.length, s = cand[0];
        const nv = cur.vals.splice(cur.vals.length - k, k);
        cur.end = s - 1;
        close();
        cur = { start: s, end: i, vals: nv };
      }
    }
    close();
    return notes;
  };

  // ---------- тональность ----------
  const KMAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KMIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  DSP.detectKey = function (notes) {
    const h = new Array(12).fill(0);
    notes.forEach((nt) => { h[pc(nt.p)] += nt.d; });
    const corr = (prof, rot) => {
      let mx = 0, my = 0;
      for (let i = 0; i < 12; i++) { mx += h[i]; my += prof[i]; }
      mx /= 12; my /= 12;
      let num = 0, dx = 0, dy = 0;
      for (let i = 0; i < 12; i++) {
        const a = h[(i + rot) % 12] - mx, b = prof[i] - my;
        num += a * b; dx += a * a; dy += b * b;
      }
      return dx > 0 ? num / Math.sqrt(dx * dy) : 0;
    };
    let best = { tonic: 0, mode: 'major', score: -2 };
    for (let r = 0; r < 12; r++) {
      const a = corr(KMAJ, r), b = corr(KMIN, r);
      if (a > best.score) best = { tonic: r, mode: 'major', score: a };
      if (b > best.score) best = { tonic: r, mode: 'minor', score: b };
    }
    best.name = NOTE_NAMES[best.tonic] + (best.mode === 'major' ? ' мажор' : ' минор');
    return best;
  };

  DSP.scalePcs = function (key) {
    const iv = key.mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10, 11];
    return iv.map((v) => (v + key.tonic) % 12);
  };

  DSP.snapToScale = function (m, key) {
    const sc = DSP.scalePcs(key);
    let best = Math.round(m), bd = 99;
    for (let c = Math.floor(m) - 2; c <= Math.ceil(m) + 2; c++) {
      if (sc.indexOf(((c % 12) + 12) % 12) < 0) continue;
      const dd = Math.abs(c - m);
      if (dd < bd) { bd = dd; best = c; }
    }
    return best;
  };

  // ---------- темп и квантование ----------
  DSP.estimateBpm = function (notes) {
    if (notes.length < 3) return 100;
    const on = notes.map((n) => n.t);
    let best = 100, bestErr = 1e9;
    for (let bpm = 66; bpm <= 150; bpm++) {
      const g = 60 / bpm / 2; // восьмая
      let err = 0;
      for (let i = 1; i < on.length; i++) {
        const q = (on[i] - on[0]) / g;
        const fr = Math.abs(q - Math.round(q));
        err += fr * fr;
      }
      err = err / (on.length - 1) + Math.abs(bpm - 100) / 1500; // лёгкое предпочтение ~100
      if (err < bestErr) { bestErr = err; best = bpm; }
    }
    return best;
  };

  // возвращает мелодию в долях: {b: начало в четвертях, d: длительность, m: midi}
  DSP.quantize = function (notes, bpm, key, snap) {
    if (!notes.length) return [];
    const e8 = 60 / bpm / 2, t0 = notes[0].t;
    let q = notes.map((n) => {
      const s = Math.round((n.t - t0) / e8);
      const e = Math.max(s + 1, Math.round((n.t + n.d - t0) / e8));
      return { s, e, m: snap ? DSP.snapToScale(n.p, key) : Math.round(n.p), dur: n.d };
    });
    q.sort((a, b) => a.s - b.s);
    const out = [];
    for (const n of q) {
      const prev = out[out.length - 1];
      if (prev && prev.s === n.s) { if (n.dur > prev.dur) out[out.length - 1] = n; continue; }
      if (prev && prev.e > n.s) prev.e = n.s;
      out.push(n);
    }
    return out.map((n) => ({ b: n.s / 2, d: (n.e - n.s) / 2, m: n.m }));
  };

  // ---------- аккорды ----------
  DSP.diatonic = function (key) {
    const maj = key.mode === 'major';
    const iv = maj ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
    const ql = maj ? ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'] : ['min', 'dim', 'maj', 'min', 'maj', 'maj', 'maj'];
    const out = [];
    for (let d = 0; d < 7; d++) {
      if (ql[d] === 'dim') continue;
      out.push({ degree: d, root: (iv[d] + key.tonic) % 12, q: ql[d] });
    }
    return out;
  };
  DSP.chordPcs = function (ch, ext) {
    const third = ch.q === 'maj' ? 4 : 3;
    const arr = [0, third, 7];
    if (ext) arr.push(ch.q === 'maj' ? (ch.degree === 4 || (ch.degree === 6) ? 10 : 11) : 10);
    return arr.map((v) => (v + ch.root) % 12);
  };
  DSP.chordName = function (ch) {
    return LAT[ch.root] + (ch.q === 'min' ? 'm' : '');
  };

  DSP.chooseChords = function (mel, key, bars) {
    const cands = DSP.diatonic(key);
    const res = [];
    let prev = null;
    for (let bar = 0; bar < bars; bar++) {
      const b0 = bar * 4, b1 = b0 + 4;
      let best = null, bs = -1e9;
      for (const c of cands) {
        const pcs = DSP.chordPcs(c);
        let s = 0;
        for (const n of mel) {
          const ov = Math.min(n.b + n.d, b1) - Math.max(n.b, b0);
          if (ov <= 0) continue;
          const p = pc(n.m);
          const strong = (n.b % 2 === 0) ? 1.3 : 1;
          s += ov * strong * (pcs.indexOf(p) >= 0 ? 1 : -0.45);
          if (p === c.root) s += 0.25 * ov;
        }
        if (c.degree === 0) s += 0.25;
        if (c.degree === 3 || c.degree === 4) s += 0.12;
        if ((bar === 0 || bar === bars - 1) && c.degree === 0) s += 1.2;
        if (prev && prev.degree === c.degree) s -= 0.1;
        if (s > bs) { bs = s; best = c; }
      }
      res.push(best); prev = best;
    }
    return res;
  };

  // ---------- продолжение мелодии ----------
  DSP.continueMelody = function (mel, key, bars, rnd = Math.random) {
    if (mel.length < 2) return [];
    const sc = DSP.scalePcs(key).slice(0, 7);
    const ladder = [];
    for (let m = 36; m <= 96; m++) if (sc.indexOf(m % 12) >= 0) ladder.push(m);
    const idx = (m) => { let bi = 0, bd = 99; ladder.forEach((v, i) => { const d = Math.abs(v - m); if (d < bd) { bd = d; bi = i; } }); return bi; };
    const steps = {}, durs = {};
    let lo = 99, hi = 0;
    for (let i = 0; i < mel.length; i++) {
      const k = idx(mel[i].m); lo = Math.min(lo, k); hi = Math.max(hi, k);
      const dk = Math.round(mel[i].d * 2); durs[dk] = (durs[dk] || 0) + 1;
      if (i) { const st = Math.max(-4, Math.min(4, k - idx(mel[i - 1].m))); steps[st] = (steps[st] || 0) + 1; }
    }
    const pick = (obj, base) => {
      const ks = Object.keys(Object.assign({}, base, obj));
      const ws = ks.map((k) => (obj[k] || 0) + (base[k] || 0));
      let tot = ws.reduce((a, b) => a + b, 0), r = rnd() * tot;
      for (let i = 0; i < ks.length; i++) { r -= ws[i]; if (r <= 0) return +ks[i]; }
      return +ks[ks.length - 1];
    };
    const last = mel[mel.length - 1];
    const startB = Math.ceil((last.b + last.d) / 4) * 4;
    const endB = startB + bars * 4;
    let b = startB, k = idx(last.m), prevSt = 99;
    const out = [];
    while (b < endB) {
      let dk = Math.min(4, Math.max(1, pick(durs, { 1: 0.5, 2: 0.5 })));
      let st = pick(steps, { '-1': 0.6, '1': 0.6, '-2': 0.3, '2': 0.3, '0': 0.2 });
      const center = (lo + hi) / 2;
      if (st === 0 && prevSt === 0) st = k < center ? 1 : -1;
      if (rnd() < 0.3 && Math.abs(k - center) > 1) st = Math.sign(center - k) * Math.max(1, Math.abs(st));
      let nk = k + st;
      if (nk < lo - 1 || nk > hi + 1) nk = k - st;
      k = Math.max(lo - 1, Math.min(hi + 1, nk));
      prevSt = st;
      let d = dk / 2;
      if (b + d >= endB - 1) { // финал — на тонику
        const m0 = ladder[k];
        let best = m0, bd = 99;
        for (let m = m0 - 6; m <= m0 + 6; m++) if (m % 12 === key.tonic && Math.abs(m - m0) < bd) { bd = Math.abs(m - m0); best = m; }
        out.push({ b, d: endB - b, m: best, gen: true });
        break;
      }
      out.push({ b, d, m: ladder[k], gen: true });
      b += d;
    }
    return out;
  };

  // ---------- аранжировка ----------
  // style: {chordMode, bassMode, drums, ext, swing, leadOct, chordOct}
  DSP.arrange = function (mel, chords, style, intro = 1) {
    const bars = chords.length;
    const off = intro * 4;
    const total = (bars + intro + 1) * 4;
    const sw = (b) => { const f = b - Math.floor(b); return (style.swing && Math.abs(f - 0.5) < 1e-6) ? b + style.swing : b; };
    const T = { lead: [], chords: [], bass: [], drums: [] };
    mel.forEach((n) => T.lead.push({ b: sw(n.b + off), d: n.d, m: n.m + (style.leadOct || 0) * 12, v: 0.8, gen: n.gen }));
    const allCh = [chords[0]].concat(chords).concat([chords[0] && chords[0].degree === 0 ? chords[0] : chords[chords.length - 1]]);
    // финальный аккорд — тоника
    const tonic = chords.find((c) => c.degree === 0) || chords[0];
    allCh[allCh.length - 1] = tonic;
    const voicing = (ch) => {
      const pcs = DSP.chordPcs(ch, style.ext);
      const base = 48 + (style.chordOct || 0) * 12;
      let r = base + ((ch.root - base) % 12 + 12) % 12;
      if (r > base + 7) r -= 12;
      return pcs.map((p) => { let m = r + ((p - ch.root + 12) % 12); return m; });
    };
    for (let bi = 0; bi < allCh.length; bi++) {
      const ch = allCh[bi]; if (!ch) continue;
      const B = bi * 4, last = bi === allCh.length - 1;
      const vc = voicing(ch);
      const rootB = 36 + ((ch.root - 36) % 12 + 12) % 12;
      const add = (b, d, ms, v) => ms.forEach((m) => T.chords.push({ b: sw(b), d, m, v }));
      if (last) { add(B, 4, vc, 0.6); T.bass.push({ b: B, d: 4, m: rootB, v: 0.8 }); T.drums.push({ b: B, k: 'crash', v: 0.7 }, { b: B, k: 'kick', v: 1 }); continue; }
      switch (style.chordMode) {
        case 'pad': add(B, 4, vc, 0.45); break;
        case 'block': add(B, 2, vc, 0.5); add(B + 2, 2, vc, 0.42); break;
        case 'arp': {
          const seq = vc.concat([vc[0] + 12, vc[1] + 12]);
          const pat = [0, 1, 2, 3, 4, 3, 2, 1];
          for (let i = 0; i < 8; i++) add(B + i / 2, 0.5, [seq[pat[i] % seq.length]], 0.45);
          break;
        }
        case 'box': {
          const seq = vc.map((m) => m + 24);
          for (let i = 0; i < 8; i++) add(B + i / 2, 1, [seq[[0, 1, 2, 1][i % 4]]], 0.35);
          break;
        }
        case 'comp': add(B, 1, vc, 0.45); add(B + 1.5, 0.5, vc, 0.38); add(B + 3, 0.5, vc, 0.35); break;
        case 'offbeat': for (let i = 0; i < 4; i++) add(B + i + 0.5, 0.4, vc, 0.45); break;
        case 'power': {
          const pw = [rootB + 12, rootB + 19, rootB + 24];
          for (let i = 0; i < 8; i++) add(B + i / 2, 0.45, pw, i % 4 === 0 ? 0.55 : 0.4);
          break;
        }
        case 'strum': add(B, 4, vc.concat([vc[0] + 12]), 0.4); break;
      }
      switch (style.bassMode) {
        case 'root': T.bass.push({ b: B, d: 1.5, m: rootB, v: 0.8 }, { b: sw(B + 2), d: 1.5, m: rootB + (bi % 2 ? 7 : 0), v: 0.7 }); break;
        case 'root8': for (let i = 0; i < 8; i++) T.bass.push({ b: B + i / 2, d: 0.45, m: rootB, v: i % 2 ? 0.6 : 0.8 }); break;
        case 'walk': {
          const nxt = allCh[bi + 1] || ch;
          const nr = 36 + ((nxt.root - 36) % 12 + 12) % 12;
          const third = ch.q === 'maj' ? 4 : 3;
          const w = [rootB, rootB + third, rootB + 7, nr + (nr > rootB + 7 ? -1 : 1)];
          w.forEach((m, i) => T.bass.push({ b: B + i, d: 0.9, m, v: 0.7 }));
          break;
        }
        case 'offbeat': for (let i = 0; i < 4; i++) T.bass.push({ b: B + i + 0.5, d: 0.4, m: rootB, v: 0.8 }); break;
        case 'pizz': T.bass.push({ b: B, d: 1, m: rootB, v: 0.7 }, { b: B + 2, d: 1, m: rootB + 7, v: 0.6 }); break;
        case 'chip': for (let i = 0; i < 8; i++) T.bass.push({ b: B + i / 2, d: 0.45, m: rootB + (i % 2 ? 12 : 0), v: 0.6 }); break;
        default: break;
      }
      const D = (b, k, v) => T.drums.push({ b: sw(b), k, v });
      switch (style.drums) {
        case 'lofi': D(B, 'kick', 0.9); D(B + 1.5, 'kick', 0.6); D(B + 2.5, 'kick', 0.5); D(B + 1, 'snare', 0.7); D(B + 3, 'snare', 0.7);
          for (let i = 0; i < 8; i++) D(B + i / 2, 'hat', i % 2 ? 0.25 : 0.4); break;
        case 'rock': D(B, 'kick', 1); D(B + 2, 'kick', 0.9); D(B + 2.5, 'kick', 0.6); D(B + 1, 'snare', 0.9); D(B + 3, 'snare', 0.9);
          for (let i = 0; i < 8; i++) D(B + i / 2, 'hat', 0.4); if (bi % 4 === 1) D(B, 'crash', 0.5); break;
        case 'jazz': for (let i = 0; i < 4; i++) D(B + i, 'ride', 0.45); D(B + 1.5, 'ride', 0.3); D(B + 3.5, 'ride', 0.3); D(B + 1, 'hat', 0.3); D(B + 3, 'hat', 0.3); D(B, 'kick', 0.35); break;
        case 'chip': D(B, 'kick', 0.8); D(B + 2, 'kick', 0.7); D(B + 1, 'snare', 0.6); D(B + 3, 'snare', 0.6); for (let i = 0; i < 8; i++) D(B + i / 2, 'hat', 0.25); break;
        case 'edm': for (let i = 0; i < 4; i++) { D(B + i, 'kick', 1); D(B + i + 0.5, 'ohat', 0.4); } D(B + 1, 'clap', 0.7); D(B + 3, 'clap', 0.7); if (bi % 4 === 1) D(B, 'crash', 0.5); break;
        case 'orch': D(B, 'tim', 0.8); if (bi % 2 === 0) D(B + 3.5, 'tim', 0.4); if (bi % 4 === 1) D(B, 'crash', 0.35); break;
        default: break;
      }
    }
    T.chords.forEach((n) => { if (style.ext === undefined) n.m = n.m; });
    return { tracks: T, totalBeats: total, introBeats: off };
  };

  // ---------- эффекты (на чистом JS) ----------
  // ratio: число или функция(n) → коэффициент высоты
  DSP.pitchShift = function (x, sr, ratio, winMs = 40) {
    const W = Math.round(sr * winMs / 1000);
    const y = new Float32Array(x.length);
    const rf = typeof ratio === 'function' ? ratio : null;
    const rArr = (ratio && typeof ratio === 'object' && ratio.length) ? ratio : null;
    let ph = 0;
    const rd = (pos) => {
      if (pos < 0) return 0;
      const i = Math.floor(pos), f = pos - i;
      const a = x[i] || 0, b = x[i + 1] || 0;
      return a + (b - a) * f;
    };
    for (let n = 0; n < x.length; n++) {
      const r = rArr ? rArr[n] : (rf ? rf(n) : ratio);
      ph += (1 - r) / W;
      ph -= Math.floor(ph);
      const p2 = (ph + 0.5) % 1;
      const w1 = Math.sin(Math.PI * ph) ** 2, w2 = 1 - w1;
      y[n] = rd(n - ph * W - 1) * w1 + rd(n - p2 * W - 1) * w2;
    }
    return y;
  };

  DSP.bitcrush = function (x, bits, hold) {
    const q = Math.pow(2, bits - 1);
    const y = new Float32Array(x.length);
    let v = 0;
    for (let i = 0; i < x.length; i++) {
      if (i % hold === 0) v = Math.round(x[i] * q) / q;
      y[i] = v;
    }
    return y;
  };

  function bpCoef(f, Q, sr) {
    const w0 = 2 * Math.PI * f / sr, al = Math.sin(w0) / (2 * Q), a0 = 1 + al;
    return { b0: al / a0, b1: 0, b2: -al / a0, a1: -2 * Math.cos(w0) / a0, a2: (1 - al) / a0 };
  }
  function biquad(x, c) {
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }

  DSP.makeCarrier = function (len, sr, kind, freq) {
    const c = new Float32Array(len);
    if (kind === 'noise') { for (let i = 0; i < len; i++) c[i] = Math.random() * 2 - 1; return c; }
    const fs = Array.isArray(freq) ? freq : null;
    const fl = fs ? null : (typeof freq === 'number' ? [freq] : null);
    const ph = [0, 0, 0, 0];
    for (let i = 0; i < len; i++) {
      if (fs) { // массив частот по сэмплам (0 → шум)
        const f = fs[i];
        if (!f) { c[i] = (Math.random() * 2 - 1) * 0.5; continue; }
        ph[0] = (ph[0] + f / sr) % 1; c[i] = ph[0] * 2 - 1;
      } else {
        let s = 0;
        for (let k = 0; k < fl.length; k++) { ph[k] = (ph[k] + fl[k] / sr) % 1; s += ph[k] * 2 - 1; }
        c[i] = s / fl.length;
      }
    }
    return c;
  };

  DSP.vocoder = function (x, sr, carrier, bands = 22) {
    const lo = 110, hi = Math.min(7500, sr * 0.45);
    const y = new Float32Array(x.length);
    const att = Math.exp(-1 / (0.004 * sr)), rel = Math.exp(-1 / (0.025 * sr));
    for (let b = 0; b < bands; b++) {
      const f = lo * Math.pow(hi / lo, b / (bands - 1));
      const c = bpCoef(f, 6, sr);
      const m = biquad(biquad(x, c), c);
      const k = biquad(biquad(carrier, c), c);
      let e = 0;
      const tilt = 1 + b / bands; // подъём верхов для разборчивости
      for (let i = 0; i < x.length; i++) {
        const v = Math.abs(m[i]);
        e = v > e ? att * e + (1 - att) * v : rel * e + (1 - rel) * v;
        y[i] += k[i] * e * tilt;
      }
    }
    return DSP.normalize(y, 0.9);
  };

  // частота основного тона по сэмплам (для автотюна и «киборга»)
  DSP.pitchPerSample = function (x, sr) {
    const tr = DSP.yinTrack(x, sr);
    const out = new Float32Array(x.length);
    const fr = tr.frameDur * sr, off = tr.offset * sr;
    for (let i = 0; i < x.length; i++) {
      const k = Math.round((i - off) / fr);
      out[i] = (k >= 0 && k < tr.f0.length) ? tr.f0[k] : 0;
    }
    return { perSample: out, track: tr };
  };

  DSP.autotune = function (x, sr, opts = {}) {
    const tr = DSP.yinTrack(x, sr);
    const frames = [];
    for (let i = 0; i < tr.f0.length; i++) if (tr.f0[i] > 0) frames.push({ p: 69 + 12 * Math.log2(tr.f0[i] / 440), d: 1 });
    const key = opts.chromatic || frames.length < 20 ? null : DSP.detectKey(frames);
    const semis = new Float32Array(tr.f0.length);
    for (let i = 0; i < tr.f0.length; i++) {
      if (tr.f0[i] <= 0) { semis[i] = NaN; continue; }
      const m = 69 + 12 * Math.log2(tr.f0[i] / 440);
      const t = key ? DSP.snapToScale(m, key) : Math.round(m);
      semis[i] = t - m + (opts.shift || 0);
    }
    // заполняем пропуски и слегка сглаживаем
    let last = opts.shift || 0;
    for (let i = 0; i < semis.length; i++) { if (isNaN(semis[i])) semis[i] = last; else last = semis[i]; }
    const sm = opts.smooth || 0.35;
    for (let i = 1; i < semis.length; i++) semis[i] = semis[i - 1] + (semis[i] - semis[i - 1]) * (1 - sm);
    const r = new Float32Array(x.length);
    const fr = tr.frameDur * sr, off = tr.offset * sr;
    for (let i = 0; i < x.length; i++) {
      const p = (i - off) / fr, k = Math.max(0, Math.min(semis.length - 1, Math.floor(p)));
      const k2 = Math.min(semis.length - 1, k + 1), f = Math.max(0, Math.min(1, p - k));
      const s = semis.length ? semis[k] + (semis[k2] - semis[k]) * f : 0;
      r[i] = Math.pow(2, s / 12);
    }
    return DSP.pitchShift(x, sr, r, 30);
  };

  // ---------- MIDI ----------
  DSP.toMidi = function (arr, bpm, programs) {
    const PPQ = 480;
    const bytes = [];
    const str = (s) => { for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i)); };
    const u32 = (v) => bytes.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
    const u16 = (v) => bytes.push((v >> 8) & 255, v & 255);
    const vlq = (v) => { const b = [v & 127]; v >>= 7; while (v) { b.unshift((v & 127) | 128); v >>= 7; } return b; };
    const ev = [];
    const tempo = Math.round(60000000 / bpm);
    ev.push({ t: 0, d: [0xff, 0x51, 3, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255] });
    const chans = { lead: 0, chords: 1, bass: 2 };
    Object.keys(chans).forEach((k) => ev.push({ t: 0, d: [0xc0 | chans[k], programs[k] || 0] }));
    Object.keys(chans).forEach((k) => (arr.tracks[k] || []).forEach((n) => {
      const t = Math.round(n.b * PPQ), e = Math.round((n.b + n.d) * PPQ) - 1;
      const v = Math.max(1, Math.min(127, Math.round(n.v * 110)));
      ev.push({ t, d: [0x90 | chans[k], n.m, v], o: 1 }, { t: Math.max(t + 1, e), d: [0x80 | chans[k], n.m, 0], o: 0 });
    }));
    const dmap = { kick: 36, snare: 38, hat: 42, ohat: 46, ride: 51, clap: 39, crash: 49, tim: 41 };
    arr.tracks.drums.forEach((n) => {
      const t = Math.round(n.b * PPQ), m = dmap[n.k] || 38;
      ev.push({ t, d: [0x99, m, Math.round(n.v * 110)], o: 1 }, { t: t + 60, d: [0x89, m, 0], o: 0 });
    });
    ev.sort((a, b) => a.t - b.t || (a.o || 0) - (b.o || 0));
    const trk = [];
    let lt = 0;
    ev.forEach((e) => { trk.push(...vlq(e.t - lt), ...e.d); lt = e.t; });
    trk.push(0, 0xff, 0x2f, 0);
    str('MThd'); u32(6); u16(0); u16(1); u16(PPQ);
    str('MTrk'); u32(trk.length); bytes.push(...trk);
    return new Uint8Array(bytes);
  };

  DSP.toWav = function (chs, sr) {
    const n = chs[0].length, nc = chs.length;
    const buf = new ArrayBuffer(44 + n * nc * 2), v = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); v.setUint32(4, 36 + n * nc * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * nc * 2, true); v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true);
    ws(36, 'data'); v.setUint32(40, n * nc * 2, true);
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
      const s = Math.max(-1, Math.min(1, chs[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
    }
    return new Uint8Array(buf);
  };

  G.DSP = DSP;
  if (typeof module !== 'undefined') module.exports = DSP;
})(typeof window !== 'undefined' ? window : globalThis);
