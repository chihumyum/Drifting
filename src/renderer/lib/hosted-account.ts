/** Account profile contract: bounded inline JPEG avatars, no external image requests. */
export const HOSTED_NAME_MAX_LENGTH = 80;
export const HOSTED_AVATAR_MAX_BYTES = 128 * 1024;
export const HOSTED_AVATAR_INPUT_MAX_BYTES = 5 * 1024 * 1024;
export const HOSTED_AVATAR_SIZE = 256;

export interface HostedProfileUpdate {
  name?: string;
  image?: string | null;
}

export function isHostedAvatar(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 23 + 4 * Math.ceil(HOSTED_AVATAR_MAX_BYTES / 3) &&
    /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(value)
  );
}

export function normalizeHostedProfileUpdate(update: HostedProfileUpdate): HostedProfileUpdate {
  const result: HostedProfileUpdate = {};
  if (update.name !== undefined) {
    const name = update.name.trim();
    if (!name || name.length > HOSTED_NAME_MAX_LENGTH) throw new Error('INVALID_PROFILE_NAME');
    result.name = name;
  }
  if (update.image !== undefined) {
    if (update.image !== null && !isHostedAvatar(update.image)) throw new Error('INVALID_AVATAR');
    result.image = update.image;
  }
  if (!Object.keys(result).length) throw new Error('EMPTY_PROFILE_UPDATE');
  return result;
}

export function validateHostedPassword(current: string, next: string, confirmation: string): void {
  if (!current) throw new Error('CURRENT_PASSWORD_REQUIRED');
  if (next.length < 8 || next.length > 128) throw new Error('INVALID_PASSWORD_LENGTH');
  if (next !== confirmation) throw new Error('PASSWORD_MISMATCH');
  if (next === current) throw new Error('PASSWORD_UNCHANGED');
}

export interface HostedAvatarSource {
  image: HTMLImageElement;
  url: string;
  release(): void;
}

export interface HostedAvatarCrop {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

/** Decode for an editable preview. The preview owner releases the URL on close. */
export async function loadHostedAvatar(file: File): Promise<HostedAvatarSource> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
    throw new Error('AVATAR_FILE_TYPE');
  if (!file.size || file.size > HOSTED_AVATAR_INPUT_MAX_BYTES) throw new Error('AVATAR_FILE_SIZE');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new Error('INVALID_AVATAR');
    }
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth * image.naturalHeight > 40_000_000
    )
      throw new Error('INVALID_AVATAR');
    return { image, url, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** Source-pixel crop shared by the preview, pointer movement and final encoding. */
export function getHostedAvatarCrop(width: number, height: number, crop: HostedAvatarCrop) {
  if (
    ![width, height, crop.zoom, crop.offsetX, crop.offsetY].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0
  )
    throw new Error('INVALID_AVATAR');
  const zoom = Math.min(4, Math.max(1, crop.zoom));
  const size = Math.min(width, height) / zoom;
  const boundX = (width - size) / 2;
  const boundY = (height - size) / 2;
  const offsetX = Math.min(boundX, Math.max(-boundX, crop.offsetX)) || 0;
  const offsetY = Math.min(boundY, Math.max(-boundY, crop.offsetY)) || 0;
  return { x: boundX - offsetX, y: boundY - offsetY, size, zoom, offsetX, offsetY };
}

/** Encode only the user-confirmed crop, removing source metadata. */
export function cropHostedAvatar(source: HostedAvatarSource, crop: HostedAvatarCrop): string {
  const { image } = source;
  const area = getHostedAvatarCrop(image.naturalWidth, image.naturalHeight, crop);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = HOSTED_AVATAR_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('INVALID_AVATAR');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, area.x, area.y, area.size, area.size, 0, 0, canvas.width, canvas.height);
  const result = canvas.toDataURL('image/jpeg', 0.85);
  if (!isHostedAvatar(result)) throw new Error('INVALID_AVATAR');
  return result;
}
