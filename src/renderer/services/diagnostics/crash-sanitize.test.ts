import { describe, expect, it } from 'vitest';
import {
  componentStackContext,
  redactHomePaths,
  reportFingerprint,
  sanitizeReportText,
  sanitizeStack,
} from './crash-sanitize';

describe('crash report sanitizing', () => {
  it('redacts prose, long quotes and home paths but keeps identifiers', () => {
    expect(sanitizeReportText('Cannot restore node:0193-abc; the typed SQLite row does not exist')).toBe(
      'Cannot restore node:0193-abc; the typed SQLite row does not exist',
    );
    expect(sanitizeReportText('无法保存：他推开门的时候，雨已经停了，街上只剩下潮湿的灯光')).toBe('[text]');
    expect(sanitizeReportText('Unexpected token in "the quick brown fox jumps over the lazy dog again and again"'))
      .toBe('Unexpected token in "[text]"');
    // Built at runtime so the source holds no personal absolute path.
    const home = ['', 'Users', 'someone'].join('/');
    expect(sanitizeReportText(`open ${home}/Library/App/drifting.db failed`)).toBe(
      'open ~/Library/App/drifting.db failed',
    );
    expect(sanitizeReportText('x'.repeat(400))).toHaveLength(300);
  });

  it('keeps the fixed wording of a failed native setup, and redacts what follows it on its own', () => {
    const prefix = 'Failed to setup app: error encountered during setup hook: ';
    expect(sanitizeReportText(`${prefix}runtime error: failed to receive message from webview`)).toBe(
      `${prefix}runtime error: failed to receive message from webview`,
    );
    expect(sanitizeReportText(`${prefix}the quick brown fox jumps over the lazy dog again and again and again`))
      .toBe(`${prefix}[text]`);
    // Only at the start: the same words elsewhere count like any others.
    expect(sanitizeReportText(`while closing: ${prefix}window not found`)).toBe('[text]');
  });

  it('redacts a Windows home folder, spaces in the name included', () => {
    // Built at runtime so the source holds no personal absolute path.
    const home = ['C:', 'Users', 'Some One'].join('\\');
    const library = `${home}\\AppData\\Local\\Drifting\\databases\\local.db`;
    expect(sanitizeReportText(`unable to open database file: ${library}`)).toBe(
      'unable to open database file: ~\\AppData\\Local\\Drifting\\databases\\local.db',
    );
    expect(redactHomePaths(`${home}\\Desktop and ${['', 'home', 'someone'].join('/')}/notes`)).toBe(
      '~\\Desktop and ~/notes',
    );
  });

  it('keeps only frames and drops the message line', () => {
    const stack = [
      'TypeError: Cannot read properties of undefined (reading "他推开门的时候雨已经停了街上只剩下灯光")',
      '    at render (tauri://localhost/assets/index-Bx9fK2aQ.js:1:2345)',
      '    at commitRoot (tauri://localhost/assets/vendor-react-a1b2c3d4.js:9:10)',
    ].join('\n');
    expect(sanitizeStack(stack)).toBe(
      'at render (tauri://localhost/assets/index-Bx9fK2aQ.js:1:2345)\nat commitRoot (tauri://localhost/assets/vendor-react-a1b2c3d4.js:9:10)',
    );
  });

  it('groups the same failure across builds whose bundle hashes differ', () => {
    const a = reportFingerprint('renderer-error', 'TypeError', 'at render (tauri://localhost/assets/index-Bx9fK2aQ.js:1:2345)');
    const b = reportFingerprint('renderer-error', 'TypeError', 'at render (tauri://localhost/assets/index-Zz81Lmq0.js:1:2345)');
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9:._-]+$/);
  });

  it('keeps the positioned component frames of a render failure, innermost first', () => {
    // A release's component stack (React 19): minified names with bundle
    // positions, host elements without. WebKit writes frames as name@url.
    const stack = [
      '',
      '    at D (http://tauri.localhost/assets/project-route-components-BrUnSqTM.js:32:88399)',
      '    at div',
      '    at section',
      '    at Rl (http://tauri.localhost/assets/project-route-components-BrUnSqTM.js:32:81022)',
      'Xm@tauri://localhost/assets/project-route-components-BrUnSqTM.js:32:80117',
      ...Array.from({ length: 12 }, (_, index) => `    at C${index} (http://tauri.localhost/assets/index-BV5Qw5OB.js:9:${index})`),
    ].join('\n');
    const context = componentStackContext(stack);
    expect(Object.keys(context)).toEqual(Array.from({ length: 8 }, (_, index) => `component${index + 1}`));
    expect(context.component1).toBe('at D (http://tauri.localhost/assets/project-route-components-BrUnSqTM.js:32:88399)');
    expect(context.component2).toBe('at Rl (http://tauri.localhost/assets/project-route-components-BrUnSqTM.js:32:81022)');
    expect(context.component3).toBe('Xm@tauri://localhost/assets/project-route-components-BrUnSqTM.js:32:80117');
    expect(Object.values(context).every((frame) => frame.length <= 200)).toBe(true);
    expect(componentStackContext(undefined)).toEqual({});
    expect(componentStackContext('\n    at div\n    at App')).toEqual({});
  });
});
