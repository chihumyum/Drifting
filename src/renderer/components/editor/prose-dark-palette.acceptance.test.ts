import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `rule ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

/** A theme block of the token sheet: `:root` or `.dark` inside `@layer base`. */
function themeBlock(css: string, selector: string): string {
  const start = css.indexOf(`\n  ${selector} {`);
  expect(start, `theme ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('\n  }', start));
}

function token(block: string, name: string): string {
  const match = block.match(new RegExp(`\\n\\s*${name}:\\s*([^;]+);`));
  expect(match, `token ${name}`).not.toBeNull();
  return match![1]!.trim();
}

/** Relative luminance of an `H S% L%` token. */
function luminance(hsl: string): number {
  const [h, s, l] = hsl.split(/\s+/).map((part) => Number.parseFloat(part)) as [number, number, number];
  const saturation = s / 100;
  const lightness = l / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lightness - chroma / 2;
  const sector = Math.floor(h / 60) % 6;
  const [r, g, b] = [
    [chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x],
  ][sector]!.map((value) => value + m) as [number, number, number];
  const linear = (value: number) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(foreground: string, background: string): number {
  return (luminance(foreground) + 0.05) / (luminance(background) + 0.05);
}

describe('prose palette in the dark theme', () => {
  const tokens = source('src/styles/index.css');

  it('maps every Tailwind Typography colour role to a theme ink', () => {
    const plugin = source('node_modules/@tailwindcss/typography/src/styles.js');
    const roles = [...new Set(
      [...plugin.matchAll(/'(--tw-prose-(?!invert-)[a-z-]+)'/g)].map((match) => match[1]!),
    )];
    // Body, headings, bold, quotes, links, code, list marks, rules and tables.
    expect(roles.length).toBeGreaterThanOrEqual(18);
    const dark = rule(tokens, '.dark .prose');
    for (const role of roles) {
      const value = dark.match(new RegExp(`${role}:\\s*([^;]+);`))?.[1];
      expect(value, `${role} in .dark .prose`).toBeDefined();
      expect(value, role).toMatch(/^hsl\(var\(--[a-z0-9-]+\)( \/ 0\.\d+)?\)$/);
    }
  });

  it('leaves the light theme on the palette it has always had', () => {
    expect(tokens).not.toMatch(/\n\.prose\s*\{/);
    expect(tokens).not.toMatch(/\n:root \.prose\s*\{/);
    const light = themeBlock(tokens, ':root');
    expect(token(light, '--prose-ink')).toBe('var(--ink-1)');
    expect(token(light, '--prose-ink-2')).toBe('var(--ink-2)');
  });

  it('writes a chapter, an entity body and a note in the prose ink', () => {
    expect(rule(tokens, '.page__body .ProseMirror')).toContain('color: hsl(var(--prose-ink));');
    expect(rule(tokens, '.page__body .ProseMirror em')).toContain('color: hsl(var(--prose-ink-2));');
    const entity = source('src/styles/entity-editors.css');
    expect(rule(entity, '.elem-body')).toContain('color: hsl(var(--prose-ink));');
    expect(rule(entity, '.elem-body .ProseMirror em')).toContain('color: hsl(var(--prose-ink-2));');
    const notes = source('src/styles/material-workbench.css');
    expect(rule(notes, '.note-prose')).toContain('color: hsl(var(--prose-ink));');
    expect(rule(notes, '.note-prose blockquote')).toContain('color: hsl(var(--prose-ink-2));');
  });

  it('softens dark prose below the first ink and keeps it easy to read', () => {
    const dark = themeBlock(tokens, '.dark');
    const page = token(dark, '--page');
    const first = contrast(token(dark, '--ink-1'), page);
    const prose = contrast(token(dark, '--prose-ink'), page);
    const second = contrast(token(dark, '--prose-ink-2'), page);
    expect(prose).toBeLessThan(first - 1.5);
    // WCAG AAA for body text is 7:1; emphasis stays a visible step below prose.
    expect(prose).toBeGreaterThanOrEqual(9);
    expect(second).toBeGreaterThanOrEqual(7);
    expect(second).toBeLessThan(prose - 2);
  });

  it('eases the words the Agent wrote back to the prose ink', () => {
    const review = source('src/styles/comments-review.css');
    const steps = [...review.matchAll(/::highlight\(agent-recent-[a-z]+-[12]\) \{ color: ([^;]+); \}/g)];
    expect(steps).toHaveLength(6);
    for (const step of steps) expect(step[1]).toContain('hsl(var(--prose-ink))');
  });
});
