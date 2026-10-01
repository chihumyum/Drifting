import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeHostedProfileUpdate,
  getHostedAvatarCrop,
  loadHostedAvatar,
  validateHostedPassword,
} from './hosted-account';

afterEach(() => vi.unstubAllGlobals());
describe('Hosted account input boundaries', () => {
  it('normalizes names and preserves explicit avatar removal', () => {
    expect(normalizeHostedProfileUpdate({ name: '  合成作者  ', image: null })).toEqual({
      name: '合成作者',
      image: null,
    });
    for (const name of ['', ' ', 'a'.repeat(81)])
      expect(() => normalizeHostedProfileUpdate({ name })).toThrow('INVALID_PROFILE_NAME');
    for (const image of [
      'https://example.test/avatar.jpg',
      'data:image/svg+xml,<svg/>',
      'data:image/jpeg;base64,/9j/' + 'a'.repeat(180_000),
    ])
      expect(() => normalizeHostedProfileUpdate({ image })).toThrow('INVALID_AVATAR');
  });
  it('checks password confirmation and length without trimming password characters', () => {
    expect(() => validateHostedPassword('old-password', ' spaces ', ' spaces ')).not.toThrow();
    expect(() => validateHostedPassword('', 'new-password', 'new-password')).toThrow(
      'CURRENT_PASSWORD_REQUIRED',
    );
    expect(() => validateHostedPassword('old-password', 'short', 'short')).toThrow(
      'INVALID_PASSWORD_LENGTH',
    );
    expect(() => validateHostedPassword('old-password', 'a'.repeat(129), 'a'.repeat(129))).toThrow(
      'INVALID_PASSWORD_LENGTH',
    );
    expect(() => validateHostedPassword('old-password', 'new-password', 'different')).toThrow(
      'PASSWORD_MISMATCH',
    );
    expect(() => validateHostedPassword('old-password', 'old-password', 'old-password')).toThrow(
      'PASSWORD_UNCHANGED',
    );
  });
  it('rejects unsafe or oversized files before creating an image decoder', async () => {
    await expect(
      loadHostedAvatar(new File(['<svg/>'], 'test.svg', { type: 'image/svg+xml' })),
    ).rejects.toThrow('AVATAR_FILE_TYPE');
    await expect(
      loadHostedAvatar(
        new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }),
      ),
    ).rejects.toThrow('AVATAR_FILE_SIZE');
  });
  it('releases object URLs when decoding fails', async () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:synthetic', revokeObjectURL: revoke });
    vi.stubGlobal(
      'Image',
      class {
        decode() {
          return Promise.reject(new Error('bad image'));
        }
      },
    );
    await expect(
      loadHostedAvatar(new File(['bad'], 'bad.jpg', { type: 'image/jpeg' })),
    ).rejects.toThrow('INVALID_AVATAR');
    expect(revoke).toHaveBeenCalledWith('blob:synthetic');
  });
});

describe('Editable avatar crop geometry', () => {
  it('keeps landscape and portrait crops covered when dragged to either edge', () => {
    const landscape = getHostedAvatarCrop(600, 400, { zoom: 1, offsetX: 500, offsetY: 500 });
    expect(landscape).toMatchObject({ x: 0, y: 0, size: 400, offsetX: 100, offsetY: 0 });
    expect(getHostedAvatarCrop(400, 600, { zoom: 1, offsetX: -500, offsetY: -500 })).toMatchObject({
      x: 0,
      y: 200,
      size: 400,
      offsetX: 0,
      offsetY: -100,
    });
  });
  it('preserves the chosen center when zooming and clamps it when zooming back out', () => {
    const zoomed = getHostedAvatarCrop(600, 400, { zoom: 2, offsetX: 100, offsetY: 50 });
    expect(zoomed).toMatchObject({ x: 100, y: 50, size: 200 });
    expect(getHostedAvatarCrop(600, 400, { ...zoomed, zoom: 1 })).toMatchObject({
      x: 0,
      y: 0,
      size: 400,
      offsetY: 0,
    });
  });
  it('bounds zoom and rejects invalid geometry', () => {
    expect(getHostedAvatarCrop(100, 100, { zoom: 99, offsetX: 0, offsetY: 0 }).size).toBe(25);
    expect(getHostedAvatarCrop(100, 100, { zoom: 0, offsetX: 0, offsetY: 0 }).size).toBe(100);
    expect(() => getHostedAvatarCrop(0, 100, { zoom: 1, offsetX: 0, offsetY: 0 })).toThrow(
      'INVALID_AVATAR',
    );
    expect(() => getHostedAvatarCrop(100, 100, { zoom: 1, offsetX: NaN, offsetY: 0 })).toThrow(
      'INVALID_AVATAR',
    );
  });
});
