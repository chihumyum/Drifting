import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { TextInputLookupStop } from './TextInputLookupStop';

const read = (relative: string) => readFileSync(resolve(import.meta.dirname, relative), 'utf8');

describe('TextInputLookupStop', () => {
  const markup = renderToStaticMarkup(createElement(TextInputLookupStop));

  it('renders a selectable zero-width caret candidate without layout or a11y footprint', () => {
    expect(markup).toBe(
      '<span data-text-input-lookup-stop="" aria-hidden="true" style="position:absolute;top:0;left:0;width:0;height:0;overflow:hidden;pointer-events:none;user-select:text;-webkit-user-select:text">​</span>',
    );
  });

  it('inherits visibility, so stops in hidden surfaces are not candidates', () => {
    expect(markup).not.toContain('visibility');
    expect(markup).not.toContain('display');
  });

  it('ends every desktop editor surface, after its content', () => {
    const source = read('./EditorMainArea.tsx');
    const surface = source.slice(source.indexOf('function WorkspaceSurface('));
    expect(surface).toMatch(/visibility: isVisible \? 'visible' : 'hidden',[\s\S]*?\{content\}\n\s*<TextInputLookupStop \/>\n\s*<\/div>/);
  });
});
