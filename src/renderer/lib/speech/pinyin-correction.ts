/**
 * Deterministic post-ASR proper-noun correction.
 *
 * Speech recognition biased by the project glossary still emits homophones
 * for invented names — the acoustic model heard the right syllables and
 * picked the wrong characters. This second layer restores the project's own
 * spelling wherever a run of characters in the transcript sounds like a
 * glossary term: exact toneless pinyin for every term, plus the common
 * fuzzy-pinyin merges (z/zh, c/ch, s/sh, n/l, -n/-ng) for terms of three or
 * more syllables, where the extra tolerance cannot plausibly hit ordinary
 * vocabulary. Everything else in the transcript is left verbatim.
 *
 * Every Han character is matched against all of its readings, so a
 * polyphone read differently in running text still lines up with the name.
 * A window that sounds like two different glossary spellings is left alone
 * rather than guessed. The pinyin dictionary loads lazily on first use.
 */

export interface TranscriptCorrection {
  index: number;
  from: string;
  to: string;
}

export interface CorrectedTranscript {
  text: string;
  corrections: TranscriptCorrection[];
}

const HAN = /^\p{Script=Han}$/u;
const FUZZY_MIN_SYLLABLES = 3;
const MAX_TERM_CHARS = 8;

type PinyinModule = typeof import('pinyin-pro');
let pinyinModule: Promise<PinyinModule> | null = null;

function loadPinyin(): Promise<PinyinModule> {
  pinyinModule ??= import('pinyin-pro');
  return pinyinModule;
}

function isHanOnly(term: string): boolean {
  return term.length >= 2 && term.length <= MAX_TERM_CHARS && [...term].every((c) => HAN.test(c));
}

export function fuzzySyllable(syllable: string): string {
  let out = syllable;
  if (out.startsWith('zh') || out.startsWith('ch') || out.startsWith('sh')) {
    out = out[0] + out.slice(2);
  } else if (out.startsWith('n')) {
    out = `l${out.slice(1)}`;
  }
  if (out.endsWith('ng')) out = out.slice(0, -1);
  return out;
}

interface GlossaryEntry {
  term: string;
  chars: string[];
  /** Readings per character, toneless. */
  readings: Set<string>[];
  fuzzyReadings: Set<string>[];
}

function readingsFor(
  cache: Map<string, Set<string>>,
  polyphonic: PinyinModule['polyphonic'],
  char: string,
): Set<string> {
  let readings = cache.get(char);
  if (!readings) {
    const all = polyphonic(char, { toneType: 'none', type: 'array' }) as unknown;
    const flat = Array.isArray(all) ? all.flat() : [];
    readings = new Set(flat.filter((r): r is string => typeof r === 'string' && r.length > 0));
    cache.set(char, readings);
  }
  return readings;
}

function fuzzySet(readings: Set<string>): Set<string> {
  return new Set([...readings].map(fuzzySyllable));
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const value of a) if (b.has(value)) return true;
  return false;
}

export async function correctTranscriptByPinyin(
  text: string,
  glossary: readonly string[],
): Promise<CorrectedTranscript> {
  const terms = [...new Set(glossary.filter(isHanOnly))].sort((a, b) => b.length - a.length);
  if (!text || terms.length === 0) return { text, corrections: [] };

  const { polyphonic } = await loadPinyin();
  const cache = new Map<string, Set<string>>();
  const entries: GlossaryEntry[] = terms.map((term) => {
    const chars = [...term];
    const readings = chars.map((c) => readingsFor(cache, polyphonic, c));
    return { term, chars, readings, fuzzyReadings: readings.map(fuzzySet) };
  });

  const chars = [...text];
  const charReadings = chars.map((c) => (HAN.test(c) ? readingsFor(cache, polyphonic, c) : null));
  const charFuzzy = charReadings.map((r) => (r ? fuzzySet(r) : null));

  const corrections: TranscriptCorrection[] = [];
  const output: string[] = [];
  let index = 0;
  while (index < chars.length) {
    let replaced = false;
    if (charReadings[index]) {
      for (const fuzzy of [false, true]) {
        const candidates = new Set<string>();
        let matchedLength = 0;
        for (const entry of entries) {
          if (fuzzy && entry.chars.length < FUZZY_MIN_SYLLABLES) continue;
          const length = entry.chars.length;
          if (matchedLength && length !== matchedLength) continue;
          if (index + length > chars.length) continue;
          let ok = true;
          for (let offset = 0; offset < length; offset += 1) {
            const window = fuzzy ? charFuzzy[index + offset] : charReadings[index + offset];
            const wanted = fuzzy ? entry.fuzzyReadings[offset] : entry.readings[offset];
            if (!window || !wanted || !intersects(window, wanted)) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
          candidates.add(entry.term);
          matchedLength = length;
        }
        if (candidates.size === 0) continue;
        const original = chars.slice(index, index + matchedLength).join('');
        if (candidates.has(original)) {
          // Already the project's spelling; keep it and skip past it whole.
          output.push(original);
          index += matchedLength;
          replaced = true;
          break;
        }
        if (candidates.size !== 1) break;
        const [term] = candidates;
        corrections.push({ index, from: original, to: term });
        output.push(term);
        index += matchedLength;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      output.push(chars[index]);
      index += 1;
    }
  }

  return { text: output.join(''), corrections };
}
