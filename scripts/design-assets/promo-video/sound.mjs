// The promo video's sound, made from the page's own list of what happens when
// (window.__promo.sounds): rain on the sea all the way through, a drop, the
// name rising and bursting, keys as each character appears, the dry brush,
// the glass sheet, the Agent's steps, and a soft pad that changes chord with
// the scenes. Everything is synthesized from fixed seeds — no recording is
// used, so there is nothing to license — and the same list gives the same
// samples every time. render.mjs writes the result and normalizes its loudness.
export const RATE = 48000;

function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}
const noise = (rand) => rand() * 2 - 1;

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
  /** Lays a mono voice at `t` seconds, panned −1…1 at equal power. */
  put(t, voice, gain = 1, pan = 0) {
    const start = Math.round(t * RATE);
    const angle = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
    const left = gain * Math.cos(angle), right = gain * Math.sin(angle);
    for (let i = 0; i < voice.length; i += 1) {
      const at = start + i;
      if (at < 0 || at >= this.l.length) continue;
      this.l[at] += voice[i] * left;
      this.r[at] += voice[i] * right;
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

// ── Voices (mono Float32Arrays) ──────────────────────────────────────

// A drop: the bubble's note rises as it closes and dies away; a big one also lands with a low body.
function drop(rand, size) {
  const out = samples(0.5);
  const f0 = (size > 0.8 ? 480 : 720) * (0.94 + 0.12 * rand());
  const sweep = 0.055, risesTo = 2.7;
  let phase = 0;
  for (let i = 0; i < out.length; i += 1) {
    const t = i / RATE;
    phase += (2 * Math.PI * f0 * risesTo ** Math.min(1, t / sweep)) / RATE;
    let x = Math.sin(phase) * (1 - Math.exp(-t / 0.0015)) * Math.exp(-t / (0.028 + 0.025 * size));
    if (size > 0.8) x += Math.sin(2 * Math.PI * 92 * t) * (1 - Math.exp(-t / 0.004)) * Math.exp(-t / 0.16) * 0.55;
    if (t < 0.004) x += noise(rand) * Math.exp(-t / 0.0007) * 0.25;
    out[i] = x;
  }
  return out;
}

// Air moving: noise in a band that sweeps from `from` to `to` Hz, shaped by `shape(u)`.
function air(rand, seconds, from, to, q, shape, mode = 'band') {
  const out = samples(seconds), filter = svf(mode);
  for (let i = 0; i < out.length; i += 1) {
    const u = i / out.length;
    out[i] = filter(noise(rand), from * (to / from) ** u, q) * shape(u);
  }
  return out;
}

// The burst's low body: a thump that falls in pitch.
function thump(seconds, from, to, decay) {
  const out = samples(seconds);
  let phase = 0;
  for (let i = 0; i < out.length; i += 1) {
    const t = i / RATE;
    phase += (2 * Math.PI * (to + (from - to) * Math.exp(-t / 0.12))) / RATE;
    out[i] = Math.sin(phase) * (1 - Math.exp(-t / 0.005)) * Math.exp(-t / decay);
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

// A key: the press (a click and the key's small body) and, a moment later, its release.
function key(rand, heavy) {
  const out = samples(0.16), band = svf('band');
  const velocity = 0.72 + 0.28 * rand();
  const centre = 2400 + 1600 * rand();
  const body = (heavy ? 140 : 190) + 60 * rand();
  const release = Math.round((0.07 + 0.035 * rand()) * RATE);
  for (let i = 0; i < out.length; i += 1) {
    const t = i / RATE, tr = (i - release) / RATE;
    let x = noise(rand) * Math.exp(-t / 0.0016);
    if (tr >= 0) x += noise(rand) * Math.exp(-tr / 0.0011) * 0.3;
    const click = band(x, centre, 1.3);
    const knock = Math.sin(2 * Math.PI * body * t) * (1 - Math.exp(-t / 0.0007)) * Math.exp(-t / (heavy ? 0.02 : 0.012));
    out[i] = (click * 1.4 + knock * (heavy ? 0.75 : 0.5)) * velocity;
  }
  return out;
}

// A soft click under a finger.
function click(rand) {
  const out = samples(0.06), band = svf('band');
  for (let i = 0; i < out.length; i += 1) {
    const t = i / RATE;
    out[i] = band(noise(rand) * Math.exp(-t / 0.0012), 2100, 1.1) * 1.3 + Math.sin(2 * Math.PI * 130 * t) * Math.exp(-t / 0.009) * 0.5;
  }
  return out;
}

// Glass rung softly: a few inharmonic partials, each dying at its own pace.
function chime(notes, length = 1.6, brightness = 1) {
  const out = samples(length);
  const partials = [[1, 1, 0.9], [2.76, 0.32 * brightness, 0.32], [5.4, 0.1 * brightness, 0.12]];
  for (const note of notes) {
    for (const [ratio, gain, decay] of partials) {
      const f = note * ratio;
      if (f > RATE * 0.45) continue;
      for (let i = 0; i < out.length; i += 1) {
        const t = i / RATE;
        out[i] += Math.sin(2 * Math.PI * f * t) * gain * (1 - Math.exp(-t / 0.002)) * Math.exp(-t / decay);
      }
    }
  }
  return out;
}

// A short soft tick.
function tick(rand, pitch = 1500) {
  const out = samples(0.05);
  for (let i = 0; i < out.length; i += 1) {
    const t = i / RATE;
    out[i] = Math.sin(2 * Math.PI * pitch * t) * (1 - Math.exp(-t / 0.0006)) * Math.exp(-t / 0.008) + noise(rand) * Math.exp(-t / 0.0005) * 0.15;
  }
  return out;
}

// A message leaving: a small round pop that rises.
function pop() {
  const out = samples(0.12);
  let phase = 0;
  for (let i = 0; i < out.length; i += 1) {
    const t = i / RATE;
    phase += (2 * Math.PI * (360 + 520 * Math.min(1, t / 0.035))) / RATE;
    out[i] = Math.sin(phase) * (1 - Math.exp(-t / 0.002)) * Math.exp(-t / 0.03);
  }
  return out;
}

// ── Beds ─────────────────────────────────────────────────────────────

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
      bus[side][i] = low(high((b0 + b1 + b2 + w * 0.1848) * 0.033, 380), 6800) * level(i / RATE);
    }
  }
  const seconds = length / RATE;
  for (let t = 0; t < seconds; t += -Math.log(1 - rand()) / 46) {
    const big = rand() < 0.05;
    const voice = samples(big ? 0.03 : 0.012), band = svf('band');
    const centre = big ? 1300 + 1500 * rand() : 2600 + 6000 * rand();
    const gain = (big ? 0.15 : 0.066) * rand() ** 2.2 * level(t);
    for (let i = 0; i < voice.length; i += 1) voice[i] = band(noise(rand) * Math.exp(-i / RATE / (big ? 0.004 : 0.0013)), centre, big ? 4 : 2.5);
    bus.put(t, voice, gain, (rand() * 2 - 1) * 0.85);
  }
  return bus;
}

const CHORDS = {
  D: [146.83, 220.0, 369.99, 554.37, 659.26],
  Bm: [123.47, 185.0, 293.66, 440.0, 554.37],
  G: [98.0, 146.83, 246.94, 369.99, 440.0],
  Em: [82.41, 123.47, 196.0, 293.66, 369.99],
  A: [110.0, 164.81, 293.66, 329.63, 493.88],
};

// A soft pad under the effects: each chord's notes as a warm tone with two
// quieter neighbours a little sharp and flat (so it shimmers without the
// beating ever cancelling it), above the low end, faded in as the last chord
// fades out and breathing with the risen word.
function pad(changes, length, breathFrom, end) {
  const bus = new Bus(length);
  changes.forEach((change, n) => {
    const next = changes[n + 1];
    const from = change.t, to = next ? next.t : end;
    const attack = n === 0 ? 1.8 : 1.1, release = next ? 1.4 : 0;
    const first = Math.max(0, Math.round((from - 0.05) * RATE)), last = Math.min(length, Math.round((to + release) * RATE));
    CHORDS[change.chord].forEach((freq, voice) => {
      const pan = voice === 0 ? 0 : (voice % 2 ? -0.45 : 0.45);
      const gain = voice === 0 ? 0.8 : 1 - voice * 0.08;
      const angle = ((pan + 1) * Math.PI) / 4;
      const low = svf('low'), high = svf('high');
      let pa = 0, pb = 0, pc = 0;
      for (let i = first; i < last; i += 1) {
        const t = i / RATE;
        const into = Math.min(1, Math.max(0, (t - from) / attack));
        const out = next ? Math.min(1, Math.max(0, 1 - (t - to) / release)) : Math.min(1, Math.max(0, (end - t) / 3));
        const swell = into * into * (3 - 2 * into) * out;
        if (swell <= 0) continue;
        pa += (2 * Math.PI * freq * 1.0012) / RATE;
        pb += (2 * Math.PI * freq * 0.9988) / RATE;
        pc += (2 * Math.PI * freq) / RATE;
        const tone = Math.sin(pc) + 0.45 * (Math.sin(pa) + Math.sin(pb)) + 0.2 * Math.sin(2 * pc) + 0.06 * Math.sin(3 * pc);
        const breath = 1 + 0.07 * Math.sin((2 * Math.PI * (t - breathFrom)) / 2.6);
        const x = high(low(tone, 1300), 90) * swell * gain * breath * 0.016;
        bus.l[i] += x * Math.cos(angle);
        bus.r[i] += x * Math.sin(angle);
      }
    });
  });
  return bus;
}

// ── Space ────────────────────────────────────────────────────────────

// Freeverb (Jezar's eight combs and four all-passes a side), for a soft room.
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
    const a = (width / 2 + 0.5), b = (1 - width) / 2;
    out.l[n] = wet[0] * a + wet[1] * b;
    out.r[n] = wet[1] * a + wet[0] * b;
  }
  return out;
}

// ── The mix ──────────────────────────────────────────────────────────

/**
 * Renders the video's sound. Returns `mix` (everything) and `effects` (all
 * but the pad, for laying other music under the video), each { l, r } at RATE.
 */
export function synthesize(sounds, duration, seed = 0x5eed) {
  const length = Math.round(duration * RATE);
  const rand = rng(seed);
  const dry = new Bus(length), send = new Bus(length);
  const at = (kind) => sounds.filter((sound) => sound.kind === kind);
  const lay = (t, voice, gain, pan, wet) => {
    dry.put(t, voice, gain, pan * 0.7);
    if (wet) send.put(t, voice, gain * wet, pan * 0.7);
  };

  // The rain has been falling before the video starts; it softens a little under the sheets so the room is heard.
  const glass = at('glass');
  const sheetsFrom = glass[0]?.t ?? Infinity, sheetsTo = glass[glass.length - 1]?.t ?? -Infinity;
  const level = (t) => {
    const under = Math.min(1, Math.max(0, (t - sheetsFrom) / 1.2)) * Math.min(1, Math.max(0, (sheetsTo + 1 - t) / 1.2));
    return Math.min(1, t / 0.25 + 0.35) * (1 - 0.5 * under) * Math.min(1, Math.max(0, (duration - t) / 2.5));
  };
  const rainBus = rain(rand, length, level);
  dry.mix(rainBus);
  send.mix(rainBus, 0.15);

  for (const sound of sounds) {
    const { t, pan = 0 } = sound;
    switch (sound.kind) {
      case 'drop':
        lay(t, drop(rand, sound.size), sound.size > 0.8 ? 0.25 : 0.15, pan, 0.7);
        break;
      case 'rise': {
        // Air drawn up as the name comes out of the water, and a breath of its settling.
        const shape = (u) => (u < 0.7 ? (u / 0.7) ** 2 : 1 - ((u - 0.7) / 0.3) ** 1.5);
        dry.putPair(t - 0.15, air(rand, 1.6, 200, 2600, 0.8, shape), air(rand, 1.6, 210, 2500, 0.8, shape), 0.24);
        send.putPair(t - 0.15, air(rand, 1.6, 200, 2600, 0.8, shape), air(rand, 1.6, 210, 2500, 0.8, shape), 0.18);
        break;
      }
      case 'burst': {
        lay(t, thump(1.2, 78, 36, 0.32), 0.3, 0, 0.3);
        const shape = (u) => Math.min(1, u * 60) * Math.exp(-u * 4.5);
        dry.putPair(t, air(rand, 1.8, 5200, 240, 0.7, shape, 'low'), air(rand, 1.8, 5000, 250, 0.7, shape, 'low'), 0.15);
        send.putPair(t, air(rand, 1.8, 5200, 240, 0.7, shape, 'low'), air(rand, 1.8, 5000, 250, 0.7, shape, 'low'), 0.15);
        break;
      }
      case 'brush':
        lay(t, brush(rand, sound.dur), 0.2, pan, 0.12);
        break;
      case 'key':
        lay(t, key(rand, sound.ch === ' ' || sound.ch === '#'), 0.3, pan, 0.06);
        break;
      case 'saved':
        lay(t, chime([1567.98, 2349.32], 0.9, 0.6), 0.025, pan, 0.4);
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
        lay(t, pop(), 0.06, pan, 0.15);
        break;
      case 'step':
      case 'mark':
      case 'reply':
        lay(t, tick(rand, sound.kind === 'step' ? 1400 : 1700), 0.03, pan, 0.2);
        break;
      case 'done':
        lay(t, chime([1318.51], 0.8, 0.5), 0.025, pan, 0.35);
        break;
      case 'erase':
        lay(t, brush(rand, sound.dur + 0.1, true), 0.16, pan, 0.08);
        break;
      case 'settle':
        lay(t, chime([880, 1318.51], 1.6), 0.03, pan, 0.45);
        break;
      case 'glass': {
        // The sheet of glass: air as it opens, changes or closes, and a faint ring.
        const [from, to] = sound.dir > 0 ? [500, 2400] : sound.dir < 0 ? [2200, 450] : [900, 1500];
        const shape = (u) => Math.sin(Math.PI * u) ** 1.5;
        lay(t, air(rand, 0.75, from, to, 0.9, shape), 0.12, 0, 0.3);
        if (sound.dir >= 0) lay(t + 0.08, chime([2093, 3135.96], 1.2, 0.4), 0.012, 0, 0.6);
        break;
      }
      case 'pill':
        lay(t, chime([1174.66, 1760], 2.2), 0.04, 0, 0.5);
        break;
      default:
        break;
    }
  }

  const rise = at('rise')[0]?.t ?? 0;
  const music = pad(at('pad'), length, rise, duration);
  send.mix(music, 0.45);
  const room = reverb(send);

  const effects = new Bus(length);
  effects.mix(dry);
  effects.mix(room, 0.9);
  const mix = new Bus(length);
  mix.mix(effects);
  mix.mix(music);
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
