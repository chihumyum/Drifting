import { describe, expect, it } from 'vitest';
import { CliError } from '../protocol';
import { buildDomExpression, requireLocator } from './dom-expression';

describe('frontend debug DOM protocol', () => {
  it('accepts the four stable locator variants', () => {
    expect(requireLocator({ locator: { kind: 'css', value: '.paper' } })).toEqual({
      kind: 'css',
      value: '.paper',
    });
    expect(requireLocator({ locator: { kind: 'debug-id', value: 'mobile-workspace' } }).kind).toBe(
      'debug-id',
    );
    expect(requireLocator({ locator: { kind: 'role', role: 'button', name: '纸张' } }).kind).toBe(
      'role',
    );
    expect(requireLocator({ locator: { kind: 'text', value: '正文' } }).kind).toBe('text');
  });

  it('rejects missing locators and safely embeds user strings', () => {
    expect(() => requireLocator({})).toThrow(CliError);
    const expression = buildDomExpression('query', {
      locator: { kind: 'text', value: '</script><script>bad()</script>' },
    });
    expect(expression).not.toContain('</script>');
    expect(expression).toContain('\\u003c/script>');
  });
});
