// The take's sound (README.md): every keystroke and click the rig made, at
// the output time the plan put it, synthesized from shaped noise (no
// recordings, no pitched beeps). Fast stretches play dozens of keys a second;
// keys closer than a hand could strike are dropped rather than smeared.

import { writeFileSync } from 'node:fs';

import type { Plan } from './plan';

const RATE = 48_000;

/** xorshift32, so a take always sounds the same. */
function random(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

interface Voice { length: number; gain: number; bright: number; body: number; bodyHz: number; decay: number }

const VOICES: Record<Plan['sounds'][number]['kind'], Voice> = {
  key: { length: 0.05, gain: 0.32, bright: 0.55, body: 0.5, bodyHz: 210, decay: 0.006 },
  space: { length: 0.07, gain: 0.34, bright: 0.4, body: 0.75, bodyHz: 150, decay: 0.009 },
  return: { length: 0.09, gain: 0.42, bright: 0.45, body: 0.8, bodyHz: 135, decay: 0.012 },
  click: { length: 0.04, gain: 0.3, bright: 0.85, body: 0.25, bodyHz: 420, decay: 0.003 },
};

export function renderSound(plan: Plan, file: string, seed = 7): void {
  const frames = Math.ceil((plan.duration + 0.5) * RATE);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const next = random(seed);
  let last = -Infinity;
  for (const sound of [...plan.sounds].sort((a, b) => a.t - b.t)) {
    // A hand does not strike more than about 22 keys a second.
    if (sound.kind !== 'click' && sound.t - last < 0.045) continue;
    if (sound.kind !== 'click') last = sound.t;
    const voice = VOICES[sound.kind];
    const gain = voice.gain * (0.8 + next() * 0.35);
    const pan = (next() - 0.5) * 0.5;
    const bodyHz = voice.bodyHz * (0.92 + next() * 0.16);
    const start = Math.round(sound.t * RATE);
    const length = Math.round(voice.length * RATE);
    // A one-pole high-pass on noise for the click, a damped sine for the body.
    let previousIn = 0;
    let previousOut = 0;
    const alpha = 0.6 + voice.bright * 0.35;
    for (let index = 0; index < length && start + index < frames; index += 1) {
      const t = index / RATE;
      const white = next() * 2 - 1;
      const high = alpha * (previousOut + white - previousIn);
      previousIn = white;
      previousOut = high;
      const click = high * Math.exp(-t / voice.decay) * voice.bright;
      const body = Math.sin(2 * Math.PI * bodyHz * t) * Math.exp(-t / (voice.decay * 2.2)) * voice.body;
      const attack = Math.min(1, index / 24);
      const sample = (click + body) * gain * attack;
      left[start + index] += sample * (1 - pan);
      right[start + index] += sample * (1 + pan);
    }
  }
  // A clicked-down keyboard, not a loud one: peak at -9 dBFS.
  let peak = 0;
  for (let index = 0; index < frames; index += 1) peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]));
  const scale = peak > 0 ? 0.355 / peak : 1;
  const data = Buffer.alloc(44 + frames * 4);
  data.write('RIFF', 0); data.writeUInt32LE(36 + frames * 4, 4); data.write('WAVE', 8);
  data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22);
  data.writeUInt32LE(RATE, 24); data.writeUInt32LE(RATE * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(frames * 4, 40);
  for (let index = 0; index < frames; index += 1) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[index] * scale)) * 32767), 44 + index * 4);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[index] * scale)) * 32767), 46 + index * 4);
  }
  writeFileSync(file, data);
}
