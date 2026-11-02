/** The first-use guide's seen marker, per local workspace identity. */
export const ALPHA_GUIDE_VERSION = 'v6';

export function alphaGuideStorageKey(userId: string): string {
  return `drifting.alpha-guide.${ALPHA_GUIDE_VERSION}:${userId}`;
}
