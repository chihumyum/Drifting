import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../platform', () => ({
  platform: { keychain: { get: mocks.get, set: mocks.set, delete: mocks.delete } },
}));

describe('BYOK keychain reads', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
  });

  it('coalesces concurrent reads for the same credential', async () => {
    let resolveRead!: (value: string | null) => void;
    mocks.get.mockReturnValueOnce(
      new Promise<string | null>((resolve) => {
        resolveRead = resolve;
      }),
    );
    const { byokKeychain } = await import('./byok-keychain');

    const first = byokKeychain.get('deepseek');
    const second = byokKeychain.get('deepseek');
    await Promise.resolve();

    expect(mocks.get).toHaveBeenCalledOnce();
    expect(mocks.get).toHaveBeenCalledWith('byok.deepseek');

    resolveRead('secret');
    await expect(Promise.all([first, second])).resolves.toEqual(['secret', 'secret']);
  });

  it('does not retain a resolved secret in the read coalescer', async () => {
    mocks.get.mockResolvedValue('secret');
    const { byokKeychain } = await import('./byok-keychain');

    await byokKeychain.get('anthropic');
    await byokKeychain.get('anthropic');

    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('migrates the legacy General Agent Anthropic key into the global provider entry', async () => {
    mocks.get.mockResolvedValueOnce(null).mockResolvedValueOnce('legacy-anthropic-secret');
    mocks.set.mockResolvedValue(true);
    mocks.delete.mockResolvedValue(true);
    const { byokKeychain } = await import('./byok-keychain');

    await expect(byokKeychain.get('anthropic')).resolves.toBe('legacy-anthropic-secret');
    expect(mocks.get).toHaveBeenNthCalledWith(1, 'byok.anthropic');
    expect(mocks.get).toHaveBeenNthCalledWith(2, 'byok.agent.anthropic');
    expect(mocks.set).toHaveBeenCalledWith('byok.anthropic', 'legacy-anthropic-secret');
    expect(mocks.delete).toHaveBeenCalledWith('byok.agent.anthropic');
  });
});
