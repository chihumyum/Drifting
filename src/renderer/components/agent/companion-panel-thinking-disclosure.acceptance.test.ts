import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('General Agent thinking disclosure', () => {
  it('keeps hydrated thinking history collapsed while opening a live stream', () => {
    const panel = source('src/renderer/components/agent/CompanionPanel.tsx');

    expect(panel).toContain(
      'const [open, setOpen] = useState(() => msg.streaming === true);',
    );
    expect(panel).not.toContain('const [open, setOpen] = useState(true);');
    expect(panel).toContain(
      'if (wasStreaming.current && !msg.streaming) setOpen(false);',
    );
  });
});
