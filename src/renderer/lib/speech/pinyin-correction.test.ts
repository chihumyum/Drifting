import { describe, expect, it } from 'vitest';
import { correctTranscriptByPinyin, fuzzySyllable } from './pinyin-correction';

const GLOSSARY = ['林雾生', '老林', '雾港', '灯塔线', '沈青梧'];

describe('pinyin proper-noun correction', () => {
  it('restores homophone misspellings of glossary terms and reports them', async () => {
    const result = await correctTranscriptByPinyin('林物生走进了误港，老临在等他。', GLOSSARY);
    expect(result.text).toBe('林雾生走进了雾港，老林在等他。');
    expect(result.corrections).toEqual([
      { index: 0, from: '林物生', to: '林雾生' },
      { index: 6, from: '误港', to: '雾港' },
      { index: 9, from: '老临', to: '老林' },
    ]);
  });

  it('leaves correct spellings, ordinary words, and non-Han text untouched', async () => {
    const input = '林雾生 said OK，雾港的雾很大，灯塔线在第三章。';
    const result = await correctTranscriptByPinyin(input, GLOSSARY);
    expect(result.text).toBe(input);
    expect(result.corrections).toEqual([]);
  });

  it('keeps an alias the author actually spoke instead of expanding it', async () => {
    const result = await correctTranscriptByPinyin('老临说', GLOSSARY);
    expect(result.text).toBe('老林说');
  });

  it('tolerates fuzzy pinyin only for longer terms', async () => {
    // 沈 (shen) vs 神 (shen) is exact; 青梧 (qing wu) vs 亲吴 (qin wu) is -n/-ng.
    const long = await correctTranscriptByPinyin('神亲吴来了', GLOSSARY);
    expect(long.text).toBe('沈青梧来了');
    // 雾港 is two syllables: 五刚 (wu gang) is exact, 五干 (wu gan) must stay.
    const short = await correctTranscriptByPinyin('去五干', GLOSSARY);
    expect(short.text).toBe('去五干');
  });

  it('refuses to guess between glossary terms that sound alike', async () => {
    const result = await correctTranscriptByPinyin('去武港', ['雾港', '武港']);
    expect(result.text).toBe('去武港');
    const ambiguous = await correctTranscriptByPinyin('去五港', ['雾港', '武港']);
    expect(ambiguous.text).toBe('去五港');
    expect(ambiguous.corrections).toEqual([]);
  });

  it('matches through polyphones by considering every reading', async () => {
    // 行 reads xing/hang; the name uses hang.
    const result = await correctTranscriptByPinyin('杭州行者到了', ['行者']);
    expect(result.text).toBe('杭州行者到了');
    const homophone = await correctTranscriptByPinyin('长安来的常安', ['长安']);
    expect(homophone.text).toBe('长安来的长安');
  });

  it('normalizes fuzzy syllables consistently', () => {
    expect(fuzzySyllable('zhang')).toBe('zan');
    expect(fuzzySyllable('chen')).toBe('cen');
    expect(fuzzySyllable('shi')).toBe('si');
    expect(fuzzySyllable('nin')).toBe('lin');
    expect(fuzzySyllable('ling')).toBe('lin');
    expect(fuzzySyllable('wu')).toBe('wu');
  });
});
