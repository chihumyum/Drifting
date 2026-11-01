// The promo video's sound, made from the page's own list of what happens when
// (window.__promo.sounds): a short score for felt piano and low strings in D
// minor that turns where the scenes turn, rain on the sea all the way through,
// and quiet, acoustic effects — keys as each character appears, the dry
// brush, air as the name rises and bursts and as the panels and the glass
// move, and soft taps for the Agent's steps. No sine bleeps: every effect is
// shaped noise, and the instruments are modelled, not sampled. Everything is
// synthesized from fixed seeds — no recording is used, so there is nothing to
// license — and the same list gives the same samples every time. render.mjs
// writes the result and sets its loudness.
export const RATE = 48000;

function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}
const noise = (rand) => rand() * 2 - 1;
const smooth = (x) => { const u = Math.min(1, Math.max(0, x)); return u * u * (3 - 2 * u); };

// A state-variable filter whose cutoff may move every sample (Zavalishin's
// topology-preserving form, stable under modulation). The band output is
// normalized to unity gain at its centre.
function svf(mode) {
  let ic1 = 0, ic2 = 0;
  return (x, cutoff, q = 0.707) => {
    const g = Math.tan((Math.PI * Math.min(cutoff, RATE * 0.45)) / RATE);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = x - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    return mode === 'low' ? v2 : mode === 'band' ? k * v1 : x - k * v1 - v2;
  };
}

class Bus {
  constructor(length) {
    this.l = new Float32Array(length);
    this.r = new Float32Array(length);
  }
  /** Lays a mono voice at `t` seconds, panned −1…1 at equal power; from `until` on it is damped. */
  put(t, voice, gain = 1, pan = 0, until = Infinity) {
    const start = Math.round(t * RATE);
    const damp = (until - t) * RATE;
    const angle = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
    const left = gain * Math.cos(angle), right = gain * Math.sin(angle);
    for (let i = 0; i < voice.length; i += 1) {
      const at = start + i;
      if (at < 0 || at >= this.l.length) continue;
      const held = i < damp ? 1 : Math.exp(-(i - damp) / (0.14 * RATE));
      if (held < 1e-4) break;
      this.l[at] += voice[i] * left * held;
      this.r[at] += voice[i] * right * held;
    }
  }
  /** Lays a stereo pair at `t` seconds. */
  putPair(t, left, right, gain = 1) {
    const start = Math.round(t * RATE);
    for (let i = 0; i < left.length; i += 1) {
      const at = start + i;
      if (at < 0 || at >= this.l.length) continue;
      this.l[at] += left[i] * gain;
      this.r[at] += right[i] * gain;
    }
  }
  mix(other, gain = 1) {
    for (let i = 0; i < this.l.length; i += 1) { this.l[i] += other.l[i] * gain; this.r[i] += other.r[i] * gain; }
  }
}

const samples = (seconds) => new Float32Array(Math.round(seconds * RATE));

// ── Effects (mono Float32Arrays), all shaped noise ───────────────────

// Air moving: noise in a band that sweeps from `from` to `to` Hz, shaped by `shape(u)`.
function air(rand, seconds, from, to, q, shape, mode = 'band') {
  const out = samples(seconds), filter = svf(mode);
  for (let i = 0; i < out.length; i += 1) {
    const u = i / out.length;
    out[i] = filter(noise(rand), from * (to / from) ** u, q) * shape(u);
  }
  return out;
}

// A dry brush on paper: grainy high noise that presses as it lands and dries as it goes.
function brush(rand, seconds, reverse = false) {
  const out = samples(seconds), high = svf('high'), band = svf('band');
  let grain = 0, target = 0, hold = 0;
  for (let i = 0; i < out.length; i += 1) {
    if (hold-- <= 0) { target = rand(); hold = Math.round((0.003 + 0.007 * rand()) * RATE); }
    grain += (target - grain) * 0.06;
    const u = reverse ? 1 - i / out.length : i / out.length;
    const land = Math.min(1, (u * seconds) / 0.014);
    const env = land * (1 - u) ** 0.7 * (0.65 + 0.35 * (1 - u));
    out[i] = band(high(noise(rand), 1400), 4600 - 1500 * u, 0.55) * (0.3 + 0.7 * grain * grain) * env;
  }
  return out;
}

// A key: the press (a click and the knock of the key) and, a moment later, its release.
function key(rand, heavy) {
  const out = samples(0.16), band = svf('band'), body = svf('band');
  const velocity = 0.72 + 0.28 * rand();
  const centre = 2400 + 1600 * rand();
  const knockAt = (heavy ? 150 : 210) + 60 * rand();
  const release = Math.round((0.07 + 0.035 * rand()) * RATE);
  for (let i = 0; i < out.length; i += 1) {
    const t = i / RATE, tr = (i - release) / RATE;
    let x = noise(rand) * Math.exp(-t / 0.0016);
    if (tr >= 0) x += noise(rand) * Math.exp(-tr / 0.0011) * 0.3;
    const click = band(x, centre, 1.3);
    const knock = body(noise(rand) * Math.exp(-t / (heavy ? 0.012 : 0.008)), knockAt, 3);
    out[i] = (click * 1.4 + knock * (heavy ? 2.2 : 1.6)) * velocity;
  }
  return out;
}

// A soft click under a finger.
function click(rand) {
  const out = samples(0.06), band = svf('band'), body = svf('band');
  for (let i = 0; i < out.length; i += 1) {
    const t = i / RATE;
    out[i] = band(noise(rand) * Math.exp(-t / 0.0012), 2100, 1.1) * 1.3 + body(noise(rand) * Math.exp(-t / 0.006), 160, 3) * 1.6;
  }
  return out;
}

// A soft tap, like a fingertip on paper, a little brighter or darker.
function tap(rand, centre) {
  const out = samples(0.05), band = svf('band');
  for (let i = 0; i < out.length; i += 1) {
    const t = i / RATE;
    out[i] = band(noise(rand) * Math.exp(-t / 0.0018), centre, 1.2) * 1.4 + noise(rand) * Math.exp(-t / 0.0004) * 0.08;
  }
  return out;
}

// Rain on the sea: a hiss of pink noise, a little different in each ear, and drops on it.
function rain(rand, length, level) {
  const bus = new Bus(length);
  for (const side of ['l', 'r']) {
    const high = svf('high'), low = svf('low');
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < length; i += 1) {
      const w = noise(rand);
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      bus[side][i] = low(high((b0 + b1 + b2 + w * 0.1848) * 0.021, 380), 6200) * level(i / RATE);
    }
  }
  const seconds = length / RATE;
  for (let t = 0; t < seconds; t += -Math.log(1 - rand()) / 46) {
    const big = rand() < 0.05;
    const voice = samples(big ? 0.03 : 0.012), band = svf('band');
    const centre = big ? 1300 + 1500 * rand() : 2600 + 6000 * rand();
    const gain = (big ? 0.095 : 0.042) * rand() ** 2.2 * level(t);
    for (let i = 0; i < voice.length; i += 1) voice[i] = band(noise(rand) * Math.exp(-i / RATE / (big ? 0.004 : 0.0013)), centre, big ? 4 : 2.5);
    bus.put(t, voice, gain, (rand() * 2 - 1) * 0.85);
  }
  return bus;
}

// ── Instruments ──────────────────────────────────────────────────────

const STEPS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const midi = (name) => {
  const [, letter, accidental, octave] = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  return 12 * (Number(octave) + 1) + STEPS[letter] + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0);
};
const hz = (note) => 440 * 2 ** ((note - 69) / 12);

// A felt piano, modelled: each partial a little sharp of its harmonic
// (inharmonicity), weaker and quicker to die the higher it is, filtered by
// the felt (a softer touch is darker) and by where the hammer strikes; two or
// three strings a note, a few cents apart, so the tone beats; a quick and a
// slow decay; and the knock of the hammer in the wood.
const struck = new Map();
function piano(note, velocity, rand) {
  const id = `${note}:${velocity.toFixed(2)}`;
  if (struck.has(id)) return struck.get(id);
  const f0 = hz(note);
  const inharmonic = 0.00012 * 2 ** ((note - 60) / 16);
  const sustain = Math.min(9, 7 * 2 ** (-(note - 45) / 20));
  const length = Math.min(6.5, Math.max(1.8, sustain * 1.1));
  const n = Math.round(length * RATE);
  const out = new Float32Array(n);
  const felt = 650 + 3400 * velocity ** 1.6;
  const tilt = 1.55 - 0.5 * velocity;
  const unison = note < 40 ? [0] : note < 52 ? [-0.45, 0.55] : [-0.7, 0.05, 0.75];
  const partials = [];
  let sum = 0;
  for (let k = 1; k <= 24; k += 1) {
    const f = k * f0 * Math.sqrt(1 + inharmonic * k * k);
    if (f > 9000) break;
    const amp = (Math.abs(Math.sin(Math.PI * k * 0.13)) / k ** tilt) * Math.exp(-f / felt);
    if (amp < 2e-4) continue;
    const decay = sustain / (1 + 0.32 * (k - 1));
    partials.push({ f, amp, fast: decay * 0.16, slow: decay });
    sum += amp;
  }
  for (const partial of partials) {
    for (const cents of unison) {
      const w = (2 * Math.PI * partial.f * 2 ** (cents / 1200)) / RATE;
      const c = Math.cos(w), s = Math.sin(w);
      const kf = Math.exp(-1 / (partial.fast * RATE)), ks = Math.exp(-1 / (partial.slow * RATE));
      const a = partial.amp / sum / unison.length;
      let re = 1, im = 0, ef = 0.62 * a, es = 0.38 * a;
      for (let i = 0; i < n; i += 1) {
        out[i] += im * (ef + es);
        const next = re * c - im * s;
        im = re * s + im * c;
        re = next;
        ef *= kf;
        es *= ks;
      }
    }
  }
  const attack = 0.0025 + 0.006 * (1 - velocity);
  const wood = svf('low');
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    out[i] = (out[i] * (1 - Math.exp(-t / attack)) + wood(noise(rand) * Math.exp(-t / 0.022), 240) * 0.35) * velocity * Math.min(1, (length - t) / 0.3);
  }
  struck.set(id, out);
  return out;
}

// Low strings: each note a few bowed voices, each with its own slight
// detuning and a vibrato that grows in, swelling in and out slowly; kept dark
// so they lie under the piano.
function strings(chords, length, end, rand) {
  const bus = new Bus(length);
  const saw = (phase, dt) => {
    let v = 2 * phase - 1;
    if (phase < dt) { const t = phase / dt; v -= t + t - t * t - 1; } else if (phase > 1 - dt) { const t = (phase - 1) / dt; v -= t * t + t + t + 1; }
    return v;
  };
  for (const chord of chords) {
    const attack = 0.9, release = 1.2;
    const first = Math.max(0, Math.round(chord.from * RATE)), last = Math.min(length, Math.round((chord.to + release) * RATE));
    chord.notes.forEach((note, k) => {
      const bass = k === 0;
      const voices = bass ? 2 : 3;
      for (let v = 0; v < voices; v += 1) {
        const detune = (rand() * 2 - 1) * 7, rate = 4.8 + rand() * 1.1, offset = rand() * 2 * Math.PI;
        const pan = bass ? -0.15 : (rand() * 2 - 1) * 0.6;
        const angle = ((pan + 1) * Math.PI) / 4;
        const gain = ((bass ? 0.7 : 0.62) * chord.level) / voices;
        const low = svf('low'), body = svf('band');
        let phase = rand();
        const f0 = hz(note);
        for (let i = first; i < last; i += 1) {
          const t = i / RATE, local = t - chord.from;
          const env = smooth(local / attack) * (t > chord.to ? smooth(1 - (t - chord.to) / release) : 1) * smooth((end - t) / 2.5);
          const depth = 9 * Math.min(1, local / 0.8);
          const f = f0 * 2 ** ((detune + depth * Math.sin(2 * Math.PI * rate * t + offset)) / 1200);
          const dt = f / RATE;
          phase += dt;
          if (phase >= 1) phase -= 1;
          const dark = low(saw(phase, dt), 1500 + 700 * env, 0.6);
          const x = (dark + body(dark, 700, 1) * 0.3) * env * gain;
          bus.l[i] += x * Math.cos(angle);
          bus.r[i] += x * Math.sin(angle);
        }
      }
    });
  }
  return bus;
}

// ── The score ────────────────────────────────────────────────────────

// The strings' chords, bass first, and the left hand's broken chords.
const VOICING = {
  Dm: ['D2', 'D3', 'F3', 'A3', 'D4'], Bb: ['Bb1', 'D3', 'F3', 'Bb3', 'D4'], F: ['F2', 'C3', 'F3', 'A3', 'C4'],
  C: ['C2', 'C3', 'E3', 'G3', 'C4'], Gm: ['G2', 'D3', 'G3', 'Bb3', 'D4'], A: ['A2', 'C#3', 'E3', 'A3', 'C#4'],
  Dm9: ['D2', 'D3', 'F3', 'A3', 'E4'],
};
const BROKEN = {
  Dm: ['D2', 'A2', 'F3', 'A2'], Bb: ['Bb1', 'F2', 'D3', 'F2'], F: ['F2', 'C3', 'A3', 'C3'],
  C: ['C2', 'G2', 'E3', 'G2'], Gm: ['G1', 'D2', 'Bb2', 'D2'], A: ['A1', 'E2', 'C#3', 'E2'],
};

/**
 * A short piece in D minor laid on the video's sections: one high A as the
 * stone drops; a falling line as the name rises; a low D struck as it bursts;
 * broken chords under the pillars (Dm Bb F C, then Gm Dm Bb A, climbing);
 * the line reaching its high A under the Agent and coming home to D minor as
 * its edit settles; the high A once more over D minor with an added ninth as
 * the video closes. Each note is damped where its chord ends, as a pedal is.
 */
function score(sounds, duration) {
  const at = (kind, name) => sounds.find((s) => s.kind === kind && (name === undefined || s.name === name))?.t;
  const h = at('section', 'hero') ?? 0.75, b = at('section', 'burst') ?? 5.25, w = at('section', 'write') ?? 5.85;
  const bu = at('section', 'build') ?? 13.25, te = at('section', 'tend') ?? 20.05, fo = at('section', 'fold') ?? 27.15, cl = at('section', 'close') ?? 28.35;
  const drop = sounds.find((s) => s.kind === 'drop' && s.size > 0.8)?.t ?? 0.25;
  const settle = Math.max(te + 5.2, at('settle') ?? te + 5.6);
  const notes = [], chords = [];
  const play = (t, names, v) => [].concat(names).forEach((name) => notes.push({ t, note: midi(name), v }));
  const broken = (from, to, chord, step, v) => {
    for (let t = from, i = 0; t < to - 0.05; t += step, i += 1) play(t, BROKEN[chord][i % 4], v * (i % 4 ? 0.8 : 1));
  };
  const hold = (from, to, chord, level) => chords.push({ from, to, notes: VOICING[chord].map(midi), level });

  play(drop, 'A5', 0.42);
  play(h, ['D2', 'A2'], 0.42);
  play(h + 0.85, 'A4', 0.46); play(h + 1.6, 'F4', 0.4); play(h + 2.05, 'E4', 0.36);
  play(h + 2.5, ['Bb1', 'F2'], 0.38); play(h + 2.5, 'D4', 0.4); play(h + 3.35, 'F4', 0.32); play(h + 3.8, 'E4', 0.3);
  hold(h, h + 2.5, 'Dm', 0.45); hold(h + 2.5, b, 'Bb', 0.55);

  play(b, ['D1', 'D2'], 0.7); play(b, ['A2', 'D3', 'F3', 'A3'], 0.42); play(b + 0.55, 'D5', 0.4);
  hold(b, w + 1.8, 'Dm', 0.75);

  const e = 0.45;
  broken(w, w + 1.8, 'Dm', e, 0.3); broken(w + 1.8, w + 3.6, 'Bb', e, 0.3); broken(w + 3.6, w + 5.4, 'F', e, 0.3); broken(w + 5.4, bu, 'C', e, 0.3);
  play(w + 0.45, 'A4', 0.4); play(w + 1.35, 'G4', 0.33); play(w + 1.8, 'F4', 0.4); play(w + 2.7, 'D4', 0.33);
  play(w + 3.6, 'A4', 0.4); play(w + 4.5, 'C5', 0.38); play(w + 5.4, 'G4', 0.4); play(w + 6.75, 'E4', 0.32);
  hold(w + 1.8, w + 3.6, 'Bb', 0.5); hold(w + 3.6, w + 5.4, 'F', 0.5); hold(w + 5.4, bu, 'C', 0.55);

  const q = 0.4125;
  broken(bu, bu + 1.65, 'Gm', q, 0.36); broken(bu + 1.65, bu + 3.3, 'Dm', q, 0.36); broken(bu + 3.3, bu + 4.95, 'Bb', q, 0.37); broken(bu + 4.95, te, 'A', q, 0.38);
  play(bu + 0.35, 'D5', 0.42); play(bu + 1.15, 'Bb4', 0.36); play(bu + 1.65, 'A4', 0.42); play(bu + 2.45, 'F4', 0.36);
  play(bu + 3.3, 'D5', 0.44); play(bu + 4.1, 'C5', 0.4); play(bu + 4.95, 'C#5', 0.46); play(bu + 5.75, 'E5', 0.5);
  hold(bu, bu + 1.65, 'Gm', 0.55); hold(bu + 1.65, bu + 3.3, 'Dm', 0.6); hold(bu + 3.3, bu + 4.95, 'Bb', 0.68); hold(bu + 4.95, te, 'A', 0.78);

  broken(te, te + 1.8, 'Bb', e, 0.44); broken(te + 1.8, te + 3.6, 'F', e, 0.44); broken(te + 3.6, te + 4.7, 'Gm', e, 0.46); broken(te + 4.7, settle, 'A', 0.3, 0.46);
  play(te + 0.25, 'D5', 0.52); play(te + 1.15, 'F5', 0.54); play(te + 1.8, 'A5', 0.6); play(te + 3.0, 'G5', 0.5);
  play(te + 3.6, 'F5', 0.52); play(te + 4.25, 'D5', 0.46); play(te + 4.7, 'C#5', 0.52); play(te + 5.1, 'E5', 0.54);
  play(settle, ['D2', 'A2', 'D3'], 0.5); play(settle, ['F4', 'A4', 'D5'], 0.48);
  hold(te, te + 1.8, 'Bb', 0.75); hold(te + 1.8, te + 3.6, 'F', 0.85); hold(te + 3.6, te + 4.7, 'Gm', 0.9); hold(te + 4.7, settle, 'A', 1); hold(settle, fo, 'Dm', 0.8);

  play(fo, ['Bb1', 'F2', 'D3'], 0.36); play(fo, ['F4', 'A4'], 0.3);
  hold(fo, cl, 'Bb', 0.6);
  play(cl, ['D2', 'A2', 'D3'], 0.44); play(cl, ['F3', 'A3', 'E4'], 0.36); play(cl + 0.7, 'A5', 0.38);
  hold(cl, duration, 'Dm9', 0.55);

  // The pedal comes up where each chord ends.
  const changes = [h + 2.5, b, w + 1.8, w + 3.6, w + 5.4, bu, bu + 1.65, bu + 3.3, bu + 4.95, te, te + 1.8, te + 3.6, te + 4.7, settle, fo, cl, Infinity];
  for (const n of notes) n.until = changes.find((c) => c > n.t + 0.01);
  return { notes, chords };
}

// ── Space ────────────────────────────────────────────────────────────

// Freeverb (Jezar's eight combs and four all-passes a side), for a soft hall.
function reverb(send, { room = 0.86, damp = 0.28, width = 1 } = {}) {
  const scale = RATE / 44100, spread = Math.round(23 * scale);
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const passes = [556, 441, 341, 225];
  const make = (offset) => ({
    combs: combs.map((n) => ({ buf: new Float32Array(Math.round(n * scale) + offset), i: 0, store: 0 })),
    passes: passes.map((n) => ({ buf: new Float32Array(Math.round(n * scale) + offset), i: 0 })),
  });
  const sides = [make(0), make(spread)];
  const out = new Bus(send.l.length);
  for (let n = 0; n < send.l.length; n += 1) {
    const input = (send.l[n] + send.r[n]) * 0.015;
    const wet = sides.map((side) => {
      let sum = 0;
      for (const comb of side.combs) {
        const y = comb.buf[comb.i];
        comb.store = y * (1 - damp) + comb.store * damp;
        comb.buf[comb.i] = input + comb.store * room;
        comb.i = (comb.i + 1) % comb.buf.length;
        sum += y;
      }
      for (const pass of side.passes) {
        const y = pass.buf[pass.i];
        pass.buf[pass.i] = sum + y * 0.5;
        pass.i = (pass.i + 1) % pass.buf.length;
        sum = y - sum;
      }
      return sum;
    });
    const a = width / 2 + 0.5, b = (1 - width) / 2;
    out.l[n] = wet[0] * a + wet[1] * b;
    out.r[n] = wet[1] * a + wet[0] * b;
  }
  return out;
}

// ── The mix ──────────────────────────────────────────────────────────

/**
 * Renders the video's sound. Returns `mix` (everything) and `effects` (rain
 * and effects without the score, for laying other music under the video),
 * each { l, r } at RATE.
 */
export function synthesize(sounds, duration, seed = 0x5eed) {
  const length = Math.round(duration * RATE);
  const rand = rng(seed);
  const effects = new Bus(length), effectsSend = new Bus(length);
  const lay = (t, voice, gain, pan, wet) => {
    effects.put(t, voice, gain, pan * 0.7);
    if (wet) effectsSend.put(t, voice, gain * wet, pan * 0.7);
  };

  // The rain has been falling before the video starts; it softens under the sheets so the room is heard.
  const glass = sounds.filter((s) => s.kind === 'glass');
  const sheetsFrom = glass[0]?.t ?? Infinity, sheetsTo = glass[glass.length - 1]?.t ?? -Infinity;
  const level = (t) => {
    const under = Math.min(1, Math.max(0, (t - sheetsFrom) / 1.2)) * Math.min(1, Math.max(0, (sheetsTo + 1 - t) / 1.2));
    return Math.min(1, t / 0.25 + 0.35) * (1 - 0.5 * under) * Math.min(1, Math.max(0, (duration - t) / 2.5));
  };
  const rainBus = rain(rand, length, level);
  effects.mix(rainBus);
  effectsSend.mix(rainBus, 0.15);

  for (const sound of sounds) {
    const { t, pan = 0 } = sound;
    switch (sound.kind) {
      case 'rise': {
        // Air drawn up as the name comes out of the water.
        const shape = (u) => (u < 0.7 ? (u / 0.7) ** 2 : 1 - ((u - 0.7) / 0.3) ** 1.5);
        effects.putPair(t - 0.15, air(rand, 1.6, 200, 2600, 0.8, shape), air(rand, 1.6, 210, 2500, 0.8, shape), 0.2);
        effectsSend.putPair(t - 0.15, air(rand, 1.6, 200, 2600, 0.8, shape), air(rand, 1.6, 210, 2500, 0.8, shape), 0.15);
        break;
      }
      case 'burst': {
        // Air falling away as the word bursts, over a low rumble of water.
        const shape = (u) => Math.min(1, u * 60) * Math.exp(-u * 4.5);
        effects.putPair(t, air(rand, 1.8, 5200, 240, 0.7, shape, 'low'), air(rand, 1.8, 5000, 250, 0.7, shape, 'low'), 0.15);
        effectsSend.putPair(t, air(rand, 1.8, 5200, 240, 0.7, shape, 'low'), air(rand, 1.8, 5000, 250, 0.7, shape, 'low'), 0.15);
        lay(t, air(rand, 1.4, 160, 60, 0.7, (u) => Math.min(1, u * 40) * Math.exp(-u * 3.5), 'low'), 0.9, 0, 0.2);
        break;
      }
      case 'brush':
        lay(t, brush(rand, sound.dur), 0.2, pan, 0.12);
        break;
      case 'key':
        lay(t, key(rand, sound.ch === ' ' || sound.ch === '#'), 0.36, pan, 0.06);
        break;
      case 'push': {
        // The panels pushed like a heavy block of ice: slow to start, then fast.
        const shape = (u) => (u < 0.85 ? (u / 0.85) ** 2.4 : 1 - (u - 0.85) / 0.15);
        lay(t, air(rand, sound.dur + 0.04, 700, 2300, 1.1, shape), 0.12, pan, 0.08);
        break;
      }
      case 'click':
        lay(t, click(rand), 0.14, pan, 0.05);
        break;
      case 'send':
        lay(t, air(rand, 0.2, 1400, 2800, 0.9, (u) => Math.sin(Math.PI * u) ** 2), 0.12, pan, 0.1);
        break;
      case 'saved':
      case 'step':
      case 'done':
      case 'mark':
      case 'reply':
        lay(t, tap(rand, { saved: 3000, step: 2400, done: 1900, mark: 2700, reply: 2200 }[sound.kind]), 0.07, pan, 0.15);
        break;
      case 'erase':
        lay(t, brush(rand, sound.dur + 0.1, true), 0.16, pan, 0.08);
        break;
      case 'glass': {
        // The sheet of glass: air as it opens, changes or closes.
        const [from, to] = sound.dir > 0 ? [500, 2400] : sound.dir < 0 ? [2200, 450] : [900, 1500];
        lay(t, air(rand, 0.75, from, to, 0.9, (u) => Math.sin(Math.PI * u) ** 1.5), 0.1, 0, 0.3);
        break;
      }
      default:
        break;
    }
  }

  // The score: the piano a little wide (low notes left, high right, as from
  // the bench), the strings under it, both in a larger hall than the effects.
  const music = new Bus(length), musicSend = new Bus(length);
  const { notes, chords } = score(sounds, duration);
  for (const n of notes) {
    const voice = piano(n.note, n.v, rand);
    const pan = Math.max(-0.5, Math.min(0.5, (n.note - 60) / 40));
    music.put(n.t, voice, 0.5, pan, n.until);
    musicSend.put(n.t, voice, 0.2, pan, n.until);
  }
  const low = strings(chords, length, duration, rand);
  music.mix(low, 0.09);
  musicSend.mix(low, 0.055);
  // Kept clear in the low end: nothing under 40 Hz, the bass of the broken
  // chords and the strings a little lighter below 140 Hz, and only what is
  // above 220 Hz sent into the hall, so the room never muddies the piano.
  for (const side of ['l', 'r']) {
    const floor = svf('high'), shelf = svf('low'), hall = svf('high');
    for (let i = 0; i < length; i += 1) {
      const fade = Math.min(1, Math.max(0, (duration - i / RATE) / 2.2));
      const x = floor(music[side][i], 40);
      music[side][i] = (x - 0.3 * shelf(x, 140)) * fade;
      musicSend[side][i] = hall(musicSend[side][i], 220);
    }
  }

  effects.mix(reverb(effectsSend), 0.9);
  const mix = new Bus(length);
  mix.mix(effects);
  mix.mix(music);
  mix.mix(reverb(musicSend, { room: 0.9, damp: 0.38 }), 0.9);
  // A gentle safety on peaks; loudness is set afterwards.
  for (const bus of [mix, effects]) {
    for (const side of ['l', 'r']) for (let i = 0; i < length; i += 1) bus[side][i] = Math.tanh(bus[side][i] * 1.2) / 1.2;
  }
  return { mix, effects };
}

/** Writes { l, r } as a 32-bit float stereo WAV. */
export function wav({ l, r }) {
  const bytes = Buffer.alloc(44 + l.length * 8);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + l.length * 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(3, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(RATE, 24);
  bytes.writeUInt32LE(RATE * 8, 28);
  bytes.writeUInt16LE(8, 32);
  bytes.writeUInt16LE(32, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(l.length * 8, 40);
  for (let i = 0; i < l.length; i += 1) {
    bytes.writeFloatLE(l[i], 44 + i * 8);
    bytes.writeFloatLE(r[i], 48 + i * 8);
  }
  return bytes;
}
