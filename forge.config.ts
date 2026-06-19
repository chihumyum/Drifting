import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { VitePlugin } from '@electron-forge/plugin-vite';

const config: ForgeConfig = {
  packagerConfig: {
    // Unpack the Claude Agent SDK's per-platform native `claude` binary from
    // the asar archive — it must be a real file on disk to be spawned.
    asar: { unpack: '**/@anthropic-ai/claude-agent-sdk-*/**' },
    // Extensionless on purpose: @electron/packager resolves it per-format from
    // src/assets/. On macOS it looks for BOTH, picking the richest the OS can use:
    //   - icon.icon  → Icon Composer source (layered). On macOS 26+ packager runs
    //     `actool` to compile it into Assets.car and sets CFBundleIconName, which
    //     is what makes the Dark / Clear / Tinted Liquid Glass variants work.
    //     Requires building on macOS 26 + Xcode 26 (actool 26). Optional — absent
    //     is fine, the .icns below is used instead.
    //   - icon.icns → fallback for macOS < 26 (and when no .icon is present).
    // (Win uses icon.ico, Linux icon.png — see the makers below.) Generate the
    // .icns/.ico/.png set with `pnpm icons`; the .icon comes straight from Icon
    // Composer. Dev-mode Dock can't use .icon, so it falls back to icon-mac.png.
    icon: './src/assets/icon',
    name: 'Drifting',
    extraResource: ['./drizzle'],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: 'Drifting',
      setupIcon: './src/assets/icon.ico',
    }),
    new MakerZIP({}, ['darwin']),
    new MakerDMG({
      name: 'Drifting',
      icon: './src/assets/icon.icns',
    }),
    new MakerRpm({}),
    new MakerDeb({
      options: {
        icon: './src/assets/icon.png',
      },
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/main/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
};

export default config;
