import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

describe('Agents on Windows (docs/windows.md)', () => {
  it('serves external Agents through the same bridge, over loopback TCP on Windows', () => {
    const bridge = read('src-tauri/src/mcp_server.rs');
    const both = '#[cfg(any(target_os = "macos", target_os = "windows"))]';
    expect(bridge).toContain(`${both}\nmod local {`);
    expect(bridge).toContain(`${both}\nmod client_config;`);
    expect(bridge).toContain('use std::net::{TcpListener as Listener, TcpStream as Stream};');
    expect(bridge).toContain('Listener::bind(("127.0.0.1", 0))');
    // Every connection file follows the launch's port; tokens still authenticate.
    expect(bridge).toContain('credential.socket_path = endpoint.clone();');
    expect(bridge).toContain('matches_hash(&g.token_hash, &hash(&credential.token))');
    expect(read('src-tauri/Cargo.toml')).toMatch(/cfg\(target_os = "windows"\)'\.dependencies\][\s\S]*?toml_edit = "0\.25"/u);
    for (const file of [
      'src/renderer/app/providers/ProjectRuntimeProvider.tsx',
      'src/renderer/components/agent/AgentMcpAccessSettings.tsx',
    ]) {
      expect(read(file), file).toContain('isWindowsDesktop');
    }
  });

  it('starts MCP servers without a console, with Windows profile folders, and stops their tree', () => {
    const stdio = read('src-tauri/src/mcp_stdio.rs');
    expect(stdio).toContain('const CREATE_NO_WINDOW: u32 = 0x0800_0000;');
    for (const key of ['"APPDATA"', '"USERPROFILE"', '"PATHEXT"', '"LOCALAPPDATA"']) expect(stdio).toContain(key);
    expect(stdio).toMatch(/resolve_command\(\s*&input\.command,\s*&\["exe", "cmd", "bat", "com"\],?\s*\)/u);
    expect(stdio).toContain('.args(["/PID", &child.id().to_string(), "/T", "/F"])');
  });

  it('sends Windows to the Microsoft Store when a HEIC or AVIF codec is missing', () => {
    expect(read('src/renderer/services/local-project-asset.service.ts')).toContain(
      "throw new ImageCodecUnavailableError(prepared.codec, prepared.error);",
    );
    const urls = read('src/renderer/lib/windows-image-codecs.ts');
    expect(urls).toContain("heic: 'https://apps.microsoft.com/detail/9NMZLZ57R3T7'");
    expect(urls).toContain("avif: 'https://apps.microsoft.com/detail/9MVZQVXJBQ9V'");
    const dialog = read('src/renderer/features/library/LibraryDialogs.tsx');
    expect(dialog).toContain('error instanceof ImageCodecUnavailableError && error.codec && getPlatformRuntime().isWindowsDesktop');
    expect(dialog).toContain('void platform.material.openExternal(codecStoreUrl);');
  });
});
