export function projectDeletionErrorKey(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === 'connect') return 'projectPicker.delete.connectRequired';
  if (code === 'account' || code === 'needs-reauth' || code === 'INVALID_GENERATION')
    return 'projectPicker.delete.accountRequired';
  if (code === 'transition' || code === 'changed') return 'projectPicker.delete.syncChanged';
  return 'projectPicker.delete.failed';
}
