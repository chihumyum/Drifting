import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

// Switching the editor tab reveals a long editor surface across a few
// synchronous commits. A layout read in between forces that surface's layout
// and resolves its styles twice; these controls re-render on every switch.
describe('controls that re-render on every editor tab switch', () => {
  it('measures the panel tab block only when the choice or the row changed', () => {
    const tabs = source('src/renderer/components/ui/PanelTabs.tsx');
    expect(tabs).toContain('if (seated.current?.chosen === chosen && seated.current.tabs === tabs) return;');
    expect(tabs).not.toContain('useLayoutEffect(() => place(true));');
  });

  it('keys the glass slider measurement on option values, not on a rebuilt array', () => {
    const slider = source('src/renderer/components/ui/GlassSlider.tsx');
    expect(slider).toContain('}, [value, optionsKey]);');
    expect(slider).toContain('}, [collapsed, onNaturalWidth, optionsKey]);');
    expect(slider).not.toContain('[value, options]');
  });

  it('reads the tab strip only when the active pill can be out of view', () => {
    const strip = source('src/renderer/components/topBars/TopTimeline/TopTimeline.tsx');
    expect(strip).toContain('if (fits && !scrolled.current) return;');
  });
});
