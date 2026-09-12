import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('./pdf-runtime-loader', () => ({ loadPdfRuntime: mocks.load }));
import { hasPdfSignature, renderPdfThumbnail } from './pdf-thumbnail';

beforeEach(() => { mocks.load.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

function renderer() {
  const canvas = { width: 0, height: 0, toBlob: vi.fn((callback: BlobCallback) => callback(new Blob(['synthetic-jpeg'], { type: 'image/jpeg' }))), toDataURL: vi.fn(() => 'data:image/jpeg;base64,c3ludGhldGlj') };
  vi.stubGlobal('window', { document: { createElement: vi.fn(() => canvas) } });
  const render = vi.fn(() => ({ promise: Promise.resolve() }));
  const page = { getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 240 * scale, height: 120 * scale })), render };
  const getPage = vi.fn(async () => page);
  const destroy = vi.fn(async () => {});
  const task = { promise: Promise.resolve({ getPage }), destroy };
  const getDocument = vi.fn((_options: { data: Uint8Array }) => task);
  mocks.load.mockResolvedValue({ getDocument });
  return { canvas, page, getPage, task, getDocument, destroy, render };
}

describe('deferred PDF thumbnail resource ownership', () => {
  it('checks signatures without loading the engine', () => {
    for (const [input, expected] of [['', false], ['%PDF', false], ['image', false], ['%PDF-1.4', true]] as const) {
      expect(hasPdfSignature(new TextEncoder().encode(input).buffer)).toBe(expected);
    }
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('preserves the caller buffer, image bounds and quality while releasing resources', async () => {
    const f = renderer(); const bytes = new TextEncoder().encode('%PDF-synthetic').buffer;
    const result = await renderPdfThumbnail(bytes, 120, 80);
    expect(f.getDocument.mock.calls[0]?.[0].data.buffer).not.toBe(bytes);
    expect(new TextDecoder().decode(bytes)).toBe('%PDF-synthetic');
    expect(result).toMatchObject({ width: 120, height: 60, mime: 'image/jpeg', sizeBytes: 14 });
    expect(f.canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.8);
    expect(f.destroy).toHaveBeenCalledOnce(); expect([f.canvas.width, f.canvas.height]).toEqual([1, 1]);
  });

  it('propagates a module load error without creating a document', async () => {
    const f = renderer(); const error = new Error('Synthetic module failure'); mocks.load.mockRejectedValue(error);
    await expect(renderPdfThumbnail(new ArrayBuffer(1), 120, 80)).rejects.toBe(error);
    expect(f.getDocument).not.toHaveBeenCalled();
  });

  it('destroys the document task even when parsing rejects before any page is available', async () => {
    const f = renderer(); const error = new Error('Synthetic parse failure'); f.task.promise = Promise.reject(error);
    await expect(renderPdfThumbnail(new ArrayBuffer(1), 120, 80)).rejects.toBe(error);
    expect(f.destroy).toHaveBeenCalledOnce(); expect(f.getPage).not.toHaveBeenCalled();
  });

  it('releases the document and canvas when page rendering fails', async () => {
    const f = renderer(); const error = new Error('Synthetic canvas failure'); f.render.mockImplementation(() => ({ promise: Promise.reject(error) }));
    await expect(renderPdfThumbnail(new ArrayBuffer(1), 120, 80)).rejects.toBe(error);
    expect(f.destroy).toHaveBeenCalledOnce(); expect([f.canvas.width, f.canvas.height]).toEqual([1, 1]);
  });

  it('releases resources when the image encoder fails', async () => {
    const f = renderer(); f.canvas.toBlob.mockImplementation((callback) => callback(null));
    await expect(renderPdfThumbnail(new ArrayBuffer(1), 120, 80)).rejects.toThrow('could not encode');
    expect(f.destroy).toHaveBeenCalledOnce(); expect([f.canvas.width, f.canvas.height]).toEqual([1, 1]);
  });
});
