import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ adopt: vi.fn(), connect: vi.fn() }));
vi.mock('../../store/auth', () => ({ useAuthStore: { getState: () => ({ adoptSession: mocks.adopt }) } }));
vi.mock('./connect', () => ({ connectHostedFromProduct: mocks.connect }));
import { finishHostedSignIn } from './sign-in';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.adopt.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue(undefined);
});

it('connects the existing local library after a verified login', async () => {
  const signal = new AbortController().signal;
  await finishHostedSignIn(signal);
  expect(mocks.adopt.mock.invocationCallOrder[0]).toBeLessThan(mocks.connect.mock.invocationCallOrder[0]);
  expect(mocks.connect).toHaveBeenCalledWith(signal);
});

it('never uploads when account ownership is rejected', async () => {
  mocks.adopt.mockRejectedValue(new Error('HOSTED_ACCOUNT_MISMATCH'));
  await expect(finishHostedSignIn(new AbortController().signal)).rejects.toThrow('HOSTED_ACCOUNT_MISMATCH');
  expect(mocks.connect).not.toHaveBeenCalled();
});

it('leaving sign-in cancels before the library is connected', async () => {
  const operation = new AbortController();
  mocks.adopt.mockImplementation(async () => { operation.abort(); });
  await expect(finishHostedSignIn(operation.signal)).rejects.toThrow();
  expect(mocks.connect).not.toHaveBeenCalled();
});
