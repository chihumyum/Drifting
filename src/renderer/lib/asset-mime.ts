const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
};

function normalizeMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const normalized = mime.split(';')[0]?.trim().toLowerCase();
  return normalized || null;
}

export function extForMime(mime: string | null | undefined, fallback = 'bin'): string {
  const normalized = normalizeMime(mime);
  return normalized ? (EXT_BY_MIME[normalized] ?? fallback) : fallback;
}

