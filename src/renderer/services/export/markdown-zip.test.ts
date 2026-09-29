import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { createPortableMarkdownZip } from './markdown-zip';

describe('portable Markdown ZIP', () => {
  it('preserves surrogate pairs across JSZip string chunk boundaries', async () => {
    const text = `${'a'.repeat(16383)}👩🏽‍🚀é尾`;
    const zip = await JSZip.loadAsync(await createPortableMarkdownZip([{ path: '合成/长章.md', text }]), { checkCRC32: true });
    expect(await zip.file('合成/长章.md')!.async('uint8array')).toEqual(new TextEncoder().encode(text));
  });
});
