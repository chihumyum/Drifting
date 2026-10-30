import { describe, expect, it } from 'vitest';

import { excerptPdfText, parsePageRange } from './material-media';
import { askMaterialVision } from './material-vision';
import type { AgentModelDriver, AgentModelRequest } from './runtime/types';

describe('PDF page ranges and text excerpts', () => {
  it('parses single pages and ranges, clamped to the document', () => {
    expect(parsePageRange(undefined, 10)).toBeNull();
    expect(parsePageRange('3', 10)).toEqual({ from: 3, to: 3 });
    expect(parsePageRange('2-50', 10)).toEqual({ from: 2, to: 10 });
    expect(() => parsePageRange('12', 10)).toThrow(/只有 10 页/);
    expect(() => parsePageRange('5-2', 10)).toThrow(/结束页/);
    expect(() => parsePageRange('第三页', 10)).toThrow(/页码/);
  });

  it('labels pages, stops at the budget and flags pages without a text layer', () => {
    const pages = ['潮汐表', '', 'x'.repeat(40), '尾页'];
    const first = excerptPdfText(pages, null, 40);
    expect(first.text).toBe('［第 1 页］\n潮汐表\n\n［第 2 页］\n（这一页没有文字层）');
    expect(first).toMatchObject({ pageCount: 4, pages: '1-2', nextPage: 3, pagesWithoutText: [2] });
    expect(excerptPdfText(pages, { from: 4, to: 4 }, 30)).toMatchObject({ pages: '4', text: '［第 4 页］\n尾页' });
  });
});

function driver(answer: string, seen: AgentModelRequest[]): AgentModelDriver {
  return {
    id: 'fake-vision',
    async *stream(request) {
      seen.push(request);
      yield { type: 'text_delta', text: answer };
      yield { type: 'finish', reason: 'end_turn' };
    },
  };
}

describe('askMaterialVision', () => {
  const base = {
    sessionId: 'session-1',
    question: '图里写了什么？',
    context: '作者素材库里的图片「海图」。',
    images: [{ mediaType: 'image/jpeg' as const, data: 'AAAA' }],
    signal: new AbortController().signal,
  };

  it('asks the session model once, with the images, and returns its text', async () => {
    const seen: AgentModelRequest[] = [];
    const answer = await askMaterialVision(driver('  北岬灯塔，1937  ', seen), {
      ...base,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
    expect(answer).toBe('北岬灯塔，1937');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ lifecycle: 'single_request', provider: 'anthropic', model: 'claude-sonnet-5', tools: [] });
    const message = seen[0]!.context.messages[0];
    expect(message?.type === 'model_message' && message.message).toMatchObject({
      role: 'user',
      images: base.images,
    });
  });

  it('refuses providers that cannot see images before sending anything', async () => {
    const seen: AgentModelRequest[] = [];
    await expect(
      askMaterialVision(driver('x', seen), { ...base, provider: 'deepseek', model: 'deepseek-v4-flash' }),
    ).rejects.toThrow(/不能看图/);
    expect(seen).toEqual([]);
  });
});
