import { describe, expect, it } from 'vitest';
import {
  ART_STYLE_FACT_KEY,
  composeImagePrompt,
  isValidMaterialProvenanceJson,
  parseMaterialProvenance,
  readArtStyle,
  serializeMaterialProvenance,
  withArtStyle,
  type MaterialProvenance,
} from './material-provenance';

const generated: MaterialProvenance = {
  v: 1,
  origin: 'generated',
  generation: {
    provider: 'chatgpt-subscription',
    model: 'gpt-image-2',
    prompt: 'An old lighthouse keeper\n\n画风：水彩',
    subjectPrompt: 'An old lighthouse keeper',
    styleText: '水彩',
    extraPrompt: null,
    target: { kind: 'element', id: 'element-1' },
    generationId: 'gen-1',
    conversationId: 'conversation-1',
    sourceItemIds: [],
    generatedAt: '2026-10-26T00:00:00.000Z',
  },
};

describe('material provenance', () => {
  it('round-trips generated and former-portrait provenance', () => {
    expect(parseMaterialProvenance(serializeMaterialProvenance(generated))).toEqual(generated);
    const former: MaterialProvenance = {
      v: 1,
      origin: 'element-portrait',
      elementId: 'element-1',
      replacedAt: '2026-10-26T00:00:00.000Z',
    };
    expect(parseMaterialProvenance(serializeMaterialProvenance(former))).toEqual(former);
  });

  it('reads unknown, malformed and future versions as no provenance', () => {
    for (const raw of [null, '', 'not json', '[]', '{"v":2,"origin":"generated"}', '{"v":1,"origin":"scan"}']) {
      expect(parseMaterialProvenance(raw)).toBeNull();
    }
    expect(isValidMaterialProvenanceJson(null)).toBe(true);
    expect(isValidMaterialProvenanceJson('{"v":1,"origin":"generated"}')).toBe(false);
    expect(isValidMaterialProvenanceJson(serializeMaterialProvenance(generated))).toBe(true);
  });
});

describe('art style fact', () => {
  it('reads, updates in place and appends the project art style', () => {
    const kv = JSON.stringify([
      { key: '文风', value: '冷峻' },
      { key: ART_STYLE_FACT_KEY, value: ' 水彩 ' },
    ]);
    expect(readArtStyle(kv)).toBe('水彩');
    expect(JSON.parse(withArtStyle(kv, '版画'))).toEqual([
      { key: '文风', value: '冷峻' },
      { key: ART_STYLE_FACT_KEY, value: '版画' },
    ]);
    expect(JSON.parse(withArtStyle('[{"key":"文风","value":"冷峻"}]', '水彩'))).toEqual([
      { key: '文风', value: '冷峻' },
      { key: ART_STYLE_FACT_KEY, value: '水彩' },
    ]);
    expect(withArtStyle('[]', '  ')).toBe('[]');
    expect(readArtStyle(null)).toBe('');
  });

  it('appends the style to the Agent subject prompt', () => {
    expect(composeImagePrompt(' A keeper ', '水彩')).toBe('A keeper\n\n画风：水彩');
    expect(composeImagePrompt('A keeper', null)).toBe('A keeper');
    expect(composeImagePrompt('A keeper', '   ')).toBe('A keeper');
  });
});
