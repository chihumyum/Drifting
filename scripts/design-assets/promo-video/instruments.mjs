// The score on GarageBand's sampled instruments, when its sound library is
// installed (GarageBand → Sound Library → Download All Available Sounds): the
// piano on its Steinway, the held chords on String Ensemble, and the parts
// only the sampled score has — horns, clarinet, flute, a plucked double bass,
// and the brass and tuba that strike with each hit. Apple's licence lets these
// sounds be used in one's own soundtracks; nothing of them is copied into the
// repository, and without the library render.mjs keeps the modelled piano and
// strings of sound.mjs.
//
// The Steinway's samples are consolidated into one CAF, which the system's
// sampler cannot open, so it is played here from the instrument's own zones:
// four velocity layers, each split by register, every third semitone sampled.
// Everything else goes through sampler.swift and the system's
// AVAudioUnitSampler, one part at a time.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bus, RATE } from './sound.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOGIC = '/Library/Application Support/Logic';
const STEINWAY = {
  exs: `${LOGIC}/Sampler Instruments/01 Acoustic Pianos/Steinway Grand Piano 2.exs`,
  caf: `${LOGIC}/EXS Factory Samples/01 Acoustic Pianos/Steinway Piano_consolidated.caf`,
};
// Each part's instrument and its level in the mix: dBFS RMS while it plays,
// or, for the short strokes of the hits, the dBFS of their loudest peak (so
// one hit played softer does not lift the others). The piano and the strings
// take the modelled instruments' levels; a part marked `swell` rises to the
// middle of each note and eases off, as a player leans on a long note.
const PIANO_LEVEL = -24.5;
const PARTS = {
  strings: { exs: 'String Ensemble', level: -33 },
  horns: { exs: 'French Horns Legato', level: -31, swell: true },
  clarinet: { exs: 'Clarinet Solo Legato', level: -31, swell: true },
  flute: { exs: 'Flute Solo Legato', level: -32, swell: true },
  bass: { exs: 'Upright Jazz Bass', level: -31 },
  stabHorns: { exs: 'French Horns Staccato', peak: -15 },
  stabTrombones: { exs: 'Trombones Staccato', peak: -15 },
  stabTuba: { exs: 'Tuba Solo Staccato', peak: -16 },
};

const instruments = existsSync(`${LOGIC}/Sampler Instruments`)
  ? readdirSync(`${LOGIC}/Sampler Instruments`, { recursive: true }).filter((file) => file.endsWith('.exs'))
  : [];
const exsOf = (name) => {
  const file = instruments.find((rel) => path.basename(rel, '.exs') === name);
  return file ? path.join(LOGIC, 'Sampler Instruments', file) : null;
};

export const garageBandInstalled = () => existsSync(STEINWAY.exs) && existsSync(STEINWAY.caf) && Object.values(PARTS).every((p) => exsOf(p.exs));

// An EXS instrument's zones, groups and global tuning (the layout Logic's
// sampler writes: 84-byte chunk headers, the kind in the signature's high
// byte; the parameter chunk lists ids, then their values; id 15 is the fine
// tune in cents).
function readExs(file) {
  const d = readFileSync(file);
  const zones = [], groups = [];
  let tune = 0;
  for (let i = 0; i + 84 <= d.length;) {
    const kind = (d.readUInt32LE(i) >>> 24) & 0x0f, size = d.readUInt32LE(i + 4), b = i + 84;
    if (kind === 1) {
      zones.push({ root: d[b + 1], fine: d.readInt8(b + 2), volume: d.readInt8(b + 4), low: d[b + 6], high: d[b + 7], start: d.readUInt32LE(b + 12), end: d.readUInt32LE(b + 24), group: d.readInt32LE(b + 88) });
    } else if (kind === 2) {
      groups.push({ name: d.toString('latin1', i + 20, i + 84).split('\0')[0], volume: d.readInt8(b), low: d[b + 5], high: d[b + 6] });
    } else if (kind === 4) {
      const count = d.readUInt32LE(b);
      for (let k = 0; k < count; k += 1) if (d[b + 4 + k] === 15) tune = d.readInt16LE(b + 4 + count + 2 * k);
    }
    if (!size) break;
    i += 84 + size;
  }
  return { zones, groups, tune };
}

const decode = (file, rate) => {
  const done = spawnSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', String(rate), '-'], { maxBuffer: 2 ** 31 });
  if (done.status !== 0) throw new Error(`instruments.mjs: could not decode ${file}`);
  return new Float32Array(done.stdout.buffer, done.stdout.byteOffset, done.stdout.length / 4);
};

function setPeak(bus, dbfs) {
  let peak = 0;
  for (let i = 0; i < bus.l.length; i += 1) peak = Math.max(peak, Math.abs(bus.l[i]), Math.abs(bus.r[i]));
  const gain = peak ? 10 ** (dbfs / 20) / peak : 1;
  for (let i = 0; i < bus.l.length; i += 1) { bus.l[i] *= gain; bus.r[i] *= gain; }
  return bus;
}

function setLevel(bus, dbfs) {
  let sum = 0, n = 0;
  for (let i = 0; i < bus.l.length; i += 1) {
    const e = (bus.l[i] * bus.l[i] + bus.r[i] * bus.r[i]) / 2;
    if (e > 1e-10) { sum += e; n += 1; }
  }
  if (!n) return bus;
  const gain = 10 ** (dbfs / 20) / Math.sqrt(sum / n);
  for (let i = 0; i < bus.l.length; i += 1) { bus.l[i] *= gain; bus.r[i] *= gain; }
  return bus;
}

// The Steinway: each note from the zone of its key in the layer of its
// velocity, resampled to its pitch, damped where its pedal comes up (except
// the top keys, which have no dampers), heard where a stone falls when it is one.
let steinwaySamples = null;
function steinway(notes, length) {
  const { zones, groups, tune } = readExs(STEINWAY.exs);
  const SOURCE = 44100;
  steinwaySamples ??= decode(STEINWAY.caf, SOURCE);
  const samples = steinwaySamples;
  const bus = new Bus(length);
  for (const n of notes) {
    const velocity = Math.max(1, Math.min(127, Math.round(127 * n.v)));
    const zone = zones.find((z) => {
      const g = groups[z.group];
      return g && !/pedal/i.test(g.name) && velocity >= g.low && velocity <= g.high && n.note >= z.low && n.note <= z.high;
    });
    if (!zone) continue;
    const group = groups[zone.group];
    const dampers = !/no dampers/i.test(group.name);
    const gain = 10 ** ((group.volume + zone.volume) / 20) * (0.6 + (0.4 * (velocity - group.low)) / Math.max(1, group.high - group.low));
    const step = 2 ** ((n.note - zone.root) / 12 + (zone.fine + tune) / 1200) * (SOURCE / RATE);
    const pan = n.pan ?? 0;
    const left = gain * Math.min(1, 1 - pan), right = gain * Math.min(1, 1 + pan);
    const start = Math.round(n.t * RATE), lift = Number.isFinite(n.until) ? (n.until - n.t) * RATE : Infinity;
    const frames = zone.end - zone.start - 2;
    for (let i = 0, pos = 0; pos < frames && start + i < length; i += 1, pos += step) {
      const held = dampers && i > lift ? Math.exp(-(i - lift) / (0.16 * RATE)) : 1;
      if (held < 1e-4) break;
      const k = Math.floor(pos), f = pos - k, at = (zone.start + k) * 2;
      bus.l[start + i] += (samples[at] + (samples[at + 2] - samples[at]) * f) * left * held;
      bus.r[start + i] += (samples[at + 1] + (samples[at + 3] - samples[at + 1]) * f) * right * held;
    }
  }
  return setLevel(bus, PIANO_LEVEL);
}

// One part through sampler.swift: its notes as MIDI, played offline, read back.
function sampled(name, notes, length, duration, work) {
  const player = path.join(work, 'sampler'), list = path.join(work, `${name}.json`), heard = path.join(work, `${name}.wav`);
  if (!existsSync(player)) {
    const built = spawnSync('swiftc', ['-O', path.join(here, 'sampler.swift'), '-o', player], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    if (built.status !== 0) throw new Error(`instruments.mjs: sampler.swift did not build: ${built.stderr}`);
  }
  writeFileSync(list, JSON.stringify(notes.map((n) => ({ t: n.t, note: n.note, off: n.off, velocity: Math.max(1, Math.min(127, Math.round(127 * n.v))) }))));
  const played = spawnSync(player, [exsOf(PARTS[name].exs), list, heard, String(duration)], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (played.status !== 0) throw new Error(`instruments.mjs: ${name} did not play: ${played.stderr}`);
  const raw = decode(heard, RATE);
  const bus = new Bus(length);
  for (let i = 0; i < length; i += 1) { bus.l[i] = raw[i * 2] ?? 0; bus.r[i] = raw[i * 2 + 1] ?? 0; }
  return bus;
}

// A shape over time from spans, scaled by each span's level, so the score's
// rise and fall carries on top of the velocities: each span rises to its
// middle and eases off, or, bowed hard, leans in and settles; between spans
// the last one's shape holds.
function shaped(bus, spans) {
  let shape = 0;
  for (let i = 0; i < bus.l.length; i += 1) {
    const t = i / RATE;
    const span = spans.findLast((s) => s.from <= t);
    const local = span ? t - span.from : 0;
    const target = !span ? 0 : span.level * (span.accent ? 1 + 0.5 * Math.exp(-local / 0.6) : 0.82 + 0.3 * Math.sin(Math.PI * Math.min(1, local / Math.max(0.1, span.to - span.from))));
    shape += (target - shape) * 0.0004;
    bus.l[i] *= shape;
    bus.r[i] *= shape;
  }
  return bus;
}

/**
 * The score (sound.mjs's score()) on GarageBand's instruments: { piano,
 * strings, orchestra }, each { l, r } at RATE; null when the library is missing.
 */
export function playOnGarageBand({ notes, chords, orchestra }, duration, work) {
  if (!garageBandInstalled()) return null;
  const length = Math.round(duration * RATE);
  // The held chords, each bowed as a whole, a chord bowed hard much louder.
  const held = chords.flatMap((chord) => chord.notes.map((note) => ({ t: chord.from, note, off: chord.to, v: chord.accent ? 0.88 : 0.41 + 0.31 * Math.min(1, chord.level) })));
  const strings = setLevel(shaped(sampled('strings', held, length, duration, work), chords), PARTS.strings.level);
  const band = new Bus(length);
  for (const name of Object.keys(PARTS).filter((p) => p !== 'strings')) {
    const notesOf = orchestra.filter((o) => o.part === name);
    if (!notesOf.length) continue;
    let bus = sampled(name, notesOf, length, duration, work);
    if (PARTS[name].swell) bus = shaped(bus, notesOf.map((o) => ({ from: o.t, to: o.off, level: o.v })));
    band.mix(PARTS[name].peak !== undefined ? setPeak(bus, PARTS[name].peak) : setLevel(bus, PARTS[name].level));
  }
  return { piano: steinway(notes, length), strings, orchestra: band };
}
