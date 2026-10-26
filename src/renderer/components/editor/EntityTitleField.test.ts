import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EntityTitleField } from './EntityTitleField';
import { isComposingEnter, stripTitleNewlines } from './entity-title-input';

describe('EntityTitleField', () => {
  it('renders a one-row textarea that can wrap instead of a clipping input', () => {
    const html = renderToStaticMarkup(
      createElement(EntityTitleField, {
        className: 'elem-hero__name',
        value: '游荡者：留存者在人类世界留下的阴影',
        onChange: () => undefined,
      }),
    );
    expect(html).toMatch(/^<textarea[^>]*class="elem-hero__name"[^>]*rows="1"/u);
    expect(html).toContain('游荡者：留存者在人类世界留下的阴影');
  });

  it('keeps a title on one logical line', () => {
    expect(stripTitleNewlines('第一行\r\n第二行\n第三行\r尾')).toBe('第一行 第二行 第三行 尾');
    expect(stripTitleNewlines('无换行')).toBe('无换行');
  });

  it('leaves Enter to an IME that is composing', () => {
    const enter = (isComposing: boolean, keyCode = 13) => ({
      key: 'Enter',
      keyCode,
      nativeEvent: { isComposing } as KeyboardEvent,
    });
    expect(isComposingEnter(enter(true))).toBe(true);
    expect(isComposingEnter(enter(false, 229))).toBe(true);
    expect(isComposingEnter(enter(false))).toBe(false);
    expect(isComposingEnter({ key: 'a', keyCode: 65, nativeEvent: { isComposing: true } as KeyboardEvent })).toBe(false);
  });
});
