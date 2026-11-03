import { describe, expect, it } from 'vitest';
import { firstRunStep } from './first-run-steps';

describe('the steps of the desktop first-run card', () => {
  it('welcomes, signs in, then asks for the Markdown folder in a Hosted build', () => {
    const fresh = { guideOpen: true, folderOpen: true, hosted: true, signingIn: false };
    expect(firstRunStep(fresh)).toBe('welcome');
    expect(firstRunStep({ ...fresh, signingIn: true })).toBe('account');
    // Local or account use chosen: the folder, once per device.
    expect(firstRunStep({ ...fresh, guideOpen: false })).toBe('folder');
    expect(firstRunStep({ ...fresh, guideOpen: false, folderOpen: false })).toBeNull();
  });

  it('asks nothing about accounts where there is none to choose', () => {
    const local = { guideOpen: true, folderOpen: true, hosted: false, signingIn: false };
    expect(firstRunStep(local)).toBe('folder');
    expect(firstRunStep({ ...local, folderOpen: false })).toBeNull();
  });
});
