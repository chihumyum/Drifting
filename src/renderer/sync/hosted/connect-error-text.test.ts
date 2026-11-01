import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import i18next, { type TFunction } from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import { syncConnectErrorText } from './connect-error-text';

let zh: TFunction;
let en: TFunction;

beforeAll(async () => {
  const load = (locale: string) =>
    JSON.parse(readFileSync(resolve(process.cwd(), `src/renderer/locales/${locale}.json`), 'utf8'));
  const make = async (lng: string, resources: unknown) => {
    const instance = i18next.createInstance();
    await instance.init({ lng, resources: { [lng]: { translation: resources as Record<string, unknown> } } });
    return instance.t;
  };
  zh = await make('zh-CN', load('zh-CN'));
  en = await make('en', load('en'));
});

describe('sync connect error text', () => {
  it('names every local project a restore stopped on, in either language', () => {
    const text = syncConnectErrorText('local-project-sync-conflict', zh, ['潮汐灯塔', '雾港']);
    expect(text).toContain('「潮汐灯塔」、「雾港」');
    expect(text).toContain('这次没有连接同步');
    expect(syncConnectErrorText('local-project-sync-conflict', en, ['The Tide Light'])).toContain('“The Tide Light”');
  });

  it('says the stored codes in words and keeps an unknown code visible', () => {
    for (const code of ['local-project-sync-conflict', 'blocked-update', 'blocked-corrupt', 'restore-failed', 'interrupted-native-activation', 'CANCELLED', 'DISCONNECT_FAILED']) {
      const text = syncConnectErrorText(code, zh);
      expect(text).not.toContain(code);
      expect(text).not.toContain('settings.hosted');
    }
    expect(syncConnectErrorText('SOMETHING_NEW', zh)).toContain('SOMETHING_NEW');
  });

  it('collects every conflicting project before the restore fails closed', () => {
    const restore = readFileSync(resolve(process.cwd(), 'src/renderer/sync/restore/cloud-restore.ts'), 'utf8');
    expect(restore).toContain('if (conflicts > 0) {');
    expect(restore).toContain('conflictingProjectIds,\n      );');
  });
});
