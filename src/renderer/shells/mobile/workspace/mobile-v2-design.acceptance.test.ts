import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repositoryRoot = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

describe('Mobile V2 frozen design contract', () => {
  const index = read('docs/mobile-v2/README.md');
  const product = read('docs/mobile-v2/product-contract.md');
  const delivery = read('docs/mobile-v2/delivery-and-acceptance.md');
  const platformFoundation = read('docs/mobile-v2/platform-and-appearance-foundation.md');
  const workspaceController = read('docs/mobile-v2/workspace-controller-and-back.md');
  const stableWorkspace = read(
    'docs/mobile-v2/unified-bar-rails-and-paper-swipe.md',
  );
  const simulator = read('docs/qa/mobile-v2-m0-simulator-baseline-2026-08-23.md');
  const platformSimulator = read(
    'docs/qa/mobile-v2-m1-platform-simulator-2026-08-23.md',
  );
  const workspaceSimulator = read(
    'docs/qa/mobile-v2-m2-workspace-back-simulator-2026-08-23.md',
  );
  const stableWorkspaceSimulator = read(
    'docs/qa/mobile-v2-m3-unified-workspace-simulator-2026-08-23.md',
  );
  const editingWorkspace = read(
    'docs/mobile-v2/editing-comments-search-and-all-chapters.md',
  );
  const editingWorkspaceSimulator = read(
    'docs/qa/mobile-v2-m4-editing-simulator-2026-08-23.md',
  );
  const planningWorkspace = read(
    'docs/mobile-v2/complete-planning-and-touch-drag.md',
  );
  const planningWorkspaceSimulator = read(
    'docs/qa/mobile-v2-m5-planning-simulator-2026-08-23.md',
  );
  const toolWorkspaces = read(
    'docs/mobile-v2/mobile-agent-library-todo-and-stats.md',
  );
  const toolWorkspacesSimulator = read(
    'docs/qa/mobile-v2-m6-agent-library-stats-simulator-2026-08-23.md',
  );
  const current = read('docs/mobile-ui-foundation.md');
  const docsIndex = read('docs/README.md');

  it('distinguishes the frozen target from shipped behavior', () => {
    expect(index).toContain('design_status: frozen');
    expect(index).toContain('implementation_status: staged_in_progress');
    expect(index).toContain('release_status: not_ready');
    expect(index).toContain('platform_foundation: simulator_accepted');
    expect(index).toContain('workspace_controller: simulator_accepted');
    expect(index).toContain('stable_paper_workspace: simulator_accepted');
    expect(index).toContain('editing_workspace: simulator_accepted');
    expect(index).toContain('planning_workspace: simulator_accepted');
    expect(index).toContain('tool_workspaces: simulator_accepted');
    expect(index).toContain('This directory defines the target. It does not claim');
    expect(current).toContain('current implemented mobile shell');
    expect(current).toContain('mobile-v2/README.md');
    expect(docsIndex).toContain('mobile-v2/README.md');
  });

  it('freezes the user-approved product boundaries', () => {
    expect(index).toContain('product_priority: writing_first');
    expect(index).toContain('panel_navigation: vertical_rail');
    expect(index).toContain('timeline_touch_drag: required');
    expect(index).toContain('all_chapters_editing: required');
    expect(index).toContain('super_view_surface: independent_fullscreen');
    expect(index).toContain('google_drive_release_gate: required');
    expect(index).toContain('dark_mode: required');
    expect(index).toContain('mobile_orientation: portrait_only');
    expect(index).toContain('expanded_tablet_shell: desktop');
  });

  it('keeps paper, panel, and Super View ownership unambiguous', () => {
    expect(product).toContain('Dashboard and all-chapters are ordinary papers.');
    expect(product).toMatch(/Super Views are independent\s+full-screen surfaces/);
    expect(product).toContain('A live editor must never be inside `transform: scale(...)`.');
    expect(product).toContain('Both structure and tool workspaces use one 56px left vertical rail.');
    expect(product).toMatch(/inset\s+left accent bars are forbidden/);
  });

  it('requires complete mobile author capability where touch can express it', () => {
    expect(product).toContain('All-chapters remains an editable ordinary paper');
    expect(product).toContain('Mobile Planning retains the full current Timeline and Plot Grid');
    expect(product).toContain('approximately 180ms stationary hold to arm a card drag');
    expect(product).toContain('An answer never writes prose automatically.');
    expect(product).toContain('Google Drive is nevertheless a hard Mobile V2 release gate.');
  });

  it('freezes one-goal-per-milestone evidence policy and the M0-M9 graph', () => {
    expect(delivery).toContain('Each milestone is an independently completed Goal.');
    for (let phase = 0; phase <= 9; phase += 1) {
      expect(delivery).toContain(`M${phase} `);
    }
    expect(delivery).toContain('Simulator and Emulator evidence never closes physical-device');
    expect(delivery).toContain('Google Drive cannot be waived');
    expect(delivery).toContain('M0-M6 complete, M7 not started');
    expect(platformFoundation).toContain('Native capability and UI shell are separate');
    expect(platformFoundation).toContain('target=mobile');
    expect(platformFoundation).toContain('shellMode=desktop');
    expect(platformSimulator).toContain('M1 iOS Simulator acceptance passed');
    expect(platformSimulator).toContain('No Simulator device, iOS runtime');
    expect(platformSimulator).toContain('Drifting was uninstalled from all three test devices');
    expect(workspaceController).toContain('One controller, five orthogonal axes');
    expect(workspaceController).toContain('Android hardware Back');
    expect(workspaceSimulator).toContain('M2 iOS Simulator and Android Emulator acceptance passed');
    expect(workspaceSimulator).toContain('No Simulator, Emulator, iOS runtime, Android system image');
    expect(workspaceSimulator).toContain('Both devices were');
    expect(stableWorkspace).toContain('One controlled bar');
    expect(stableWorkspace).toContain('Two one-level vertical rails');
    expect(stableWorkspace).toContain('The old paper pinch');
    expect(stableWorkspaceSimulator).toContain('M3 iOS Simulator acceptance passed');
    expect(stableWorkspaceSimulator).toContain('No Simulator, runtime');
    expect(stableWorkspaceSimulator).toContain('inputPath=synthetic-dom');
    expect(stableWorkspaceSimulator).toContain('The preference was restored to `0`');
    expect(editingWorkspace).toContain(
      'M4 implementation and Simulator/Emulator acceptance complete',
    );
    expect(editingWorkspace).toContain('WindowInsetsCompat.Type.ime()');
    expect(editingWorkspace).toContain('exactly one live chapter');
    expect(editingWorkspaceSimulator).toContain('M4 Simulator/Emulator acceptance passed');
    expect(editingWorkspaceSimulator).toContain('336.381px');
    expect(editingWorkspaceSimulator).toContain('count increased from');
    expect(planningWorkspace).toContain(
      'M5 implementation and Simulator/Emulator acceptance complete',
    );
    expect(planningWorkspace).toContain('approximately 180ms hold arms drag');
    expect(planningWorkspace).toContain('exactly-once');
    expect(planningWorkspaceSimulator).toContain(
      'M5 Simulator/Emulator acceptance passed',
    );
    expect(planningWorkspaceSimulator).toContain('book_order=8.8');
    expect(planningWorkspaceSimulator).toContain('nativeInput=false');
    expect(toolWorkspaces).toContain(
      'M6 implementation and Simulator/Emulator acceptance complete',
    );
    expect(toolWorkspaces).toContain('hard runtime boundary');
    expect(toolWorkspaces).toContain('author-controlled actions');
    expect(toolWorkspacesSimulator).toContain(
      'M6 Simulator/Emulator acceptance passed',
    );
    expect(toolWorkspacesSimulator).toContain('inputPath=synthetic-dom');
    expect(toolWorkspacesSimulator).toMatch(/from `bottom-full` to\s+`bottom-docked`/);
    expect(simulator).toContain('M0 baseline passed');
    expect(simulator).toContain('does **not** verify the future unified bar');
    expect(simulator).toContain('No new Simulator device or iOS runtime was created');
  });
});
