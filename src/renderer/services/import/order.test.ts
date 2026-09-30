import { describe, expect, it } from 'vitest';
import { orderImportFiles } from './types';

describe('chapter import order', () => {
  it('preserves numeric chapter order regardless of native picker enumeration', () => {
    const files = ['10_chapter.md', '2_chapter.md', '01_chapter.md'].map((name) => ({ name }));
    const expected = ['01_chapter.md', '2_chapter.md', '10_chapter.md'];
    expect(orderImportFiles(files).map((file) => file.name)).toEqual(expected);
    expect(orderImportFiles([...files].reverse()).map((file) => file.name)).toEqual(expected);
    expect(files[0].name).toBe('10_chapter.md');
  });

  it('keeps numbered folders and repeated chapter filenames in source path order', () => {
    const paths = ['book/10_part/1.md', 'book/2_part/10.md', 'book/2_part/2.md', 'book/1_part/1.md'];
    const files = paths.map((webkitRelativePath) => ({
      name: webkitRelativePath.split('/').pop()!,
      webkitRelativePath,
    }));
    expect(orderImportFiles(files).map((file) => file.webkitRelativePath)).toEqual([
      'book/1_part/1.md', 'book/2_part/2.md', 'book/2_part/10.md', 'book/10_part/1.md',
    ]);
  });

  it('breaks numerically equivalent filename ties deterministically', () => {
    const files = [{ name: '2.md' }, { name: '02.md' }];
    expect(orderImportFiles(files)).toEqual(orderImportFiles([...files].reverse()));
  });
});
