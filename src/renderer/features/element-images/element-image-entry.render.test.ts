import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ImageInboxEntry } from '../../platform';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));
vi.mock('../../platform', () => ({ platform: {} }));

const { ElementImageEntry } = await import('./ElementImageEntry');

function workflow(overrides: { candidates?: ImageInboxEntry[]; generationState?: 'idle' | 'starting' | 'running' } = {}) {
  const noop = () => undefined;
  return {
    prepareGenerate: noop,
    generationState: overrides.generationState ?? 'idle',
    formProps: { styleText: '', quota: null, blockedReason: null, onSubmit: noop },
    candidateProps: {
      candidates: overrides.candidates ?? [],
      generation: overrides.generationState ?? 'idle',
      busyCandidateId: null,
      error: null,
      onOpenSession: noop,
      onSetPortrait: noop,
      onKeep: noop,
      onDiscard: noop,
      onPreview: noop,
    },
    preview: null,
  } as unknown as Parameters<typeof ElementImageEntry>[0]['workflow'];
}

function render(props: Partial<Parameters<typeof ElementImageEntry>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(ElementImageEntry, {
      imageUrl: null,
      hasImage: false,
      busy: false,
      error: null,
      onViewLarge: () => undefined,
      onImportFromFile: () => undefined,
      onRemove: () => undefined,
      workflow: workflow(),
      ...props,
    }),
  );
}

describe('ElementImageEntry button', () => {
  it('shows the element image as a thumbnail, or an image icon when there is none', () => {
    const withImage = render({ imageUrl: 'asset://image', hasImage: true });
    expect(withImage).toContain('editor-bar__icon--thumb');
    expect(withImage).toContain('<img class="editor-bar__thumb" src="asset://image"');
    expect(withImage).toContain('aria-label="elementEditor.imageEntry.label"');

    const empty = render();
    expect(empty).not.toContain('editor-bar__thumb');
    expect(empty).toContain('<svg');
  });

  it('spins while generating and otherwise counts waiting candidates', () => {
    const candidate = { id: 'c1' } as ImageInboxEntry;
    expect(render({ workflow: workflow({ generationState: 'running', candidates: [candidate] }) })).toContain(
      'editor-bar__spinner',
    );
    const waiting = render({ workflow: workflow({ candidates: [candidate, { id: 'c2' } as ImageInboxEntry] }) });
    expect(waiting).toContain('<span class="editor-bar__badge">2</span>');
    expect(waiting).not.toContain('editor-bar__spinner');
  });

  it('keeps the popover closed until the button is used', () => {
    expect(render({ imageUrl: 'asset://image', hasImage: true })).not.toContain('elem-image-menu');
  });
});
