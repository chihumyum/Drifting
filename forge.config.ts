import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { VitePlugin } from '@electron-forge/plugin-vite';
import path from 'node:path';
import { cp, mkdir, readFile, readdir } from 'node:fs/promises';

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      // plugin-vite externalizes native addons + un-bundleable ESM; their .node /
      // .dylib binaries — and the Claude Agent SDK's spawned `claude` binary — must
      // be real files on disk, so unpack them out of the asar archive.
      unpack: '**/{*.node,*.dylib,@anthropic-ai/claude-agent-sdk-*/**}',
    },
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
  hooks: {
    // plugin-vite bundles the JS with Vite and deliberately ships ONLY the .vite
    // output + package.json — node_modules is omitted. So every module marked
    // `external` in vite.main.config.ts (native addons + ESM Vite can't bundle)
    // AND its full dependency subtree must be copied into the package by hand, or
    // the packaged app throws "Cannot find module ...". node_modules here is
    // hoisted+flat (.npmrc node-linker=hoisted), so each package is a real
    // top-level directory and a plain recursive copy is enough.
    async packageAfterCopy(_forgeConfig, buildPath) {
      const srcRoot = path.resolve(process.cwd(), 'node_modules');
      const destRoot = path.join(buildPath, 'node_modules');

      const roots = ['better-sqlite3', '@napi-rs/keyring', '@anthropic-ai/claude-agent-sdk'];
      // Vite externalizes the whole @langchain/* scope — include every installed one.
      try {
        for (const name of await readdir(path.join(srcRoot, '@langchain'))) {
          roots.push(`@langchain/${name}`);
        }
      } catch {
        // no @langchain scope installed — fine
      }

      // Transitively gather dependencies + optionalDependencies (the latter carry
      // the per-platform prebuilt binary packages), skipping anything not actually
      // installed (e.g. other platforms' optional deps).
      const collected = new Set<string>();
      const collect = async (name: string): Promise<void> => {
        if (collected.has(name)) return;
        let pkg: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
        try {
          pkg = JSON.parse(await readFile(path.join(srcRoot, name, 'package.json'), 'utf8'));
        } catch {
          return; // not installed for this platform — skip
        }
        collected.add(name);
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
        for (const dep of Object.keys(deps)) await collect(dep);
      };
      for (const root of roots) await collect(root);

      await Promise.all(
        [...collected].map(async (name) => {
          await mkdir(path.dirname(path.join(destRoot, name)), { recursive: true });
          await cp(path.join(srcRoot, name), path.join(destRoot, name), {
            recursive: true,
            preserveTimestamps: true,
          });
        }),
      );
      // eslint-disable-next-line no-console
      console.log(`[forge] packageAfterCopy: bundled ${collected.size} runtime modules`);
    },
  },
};

export default config;
