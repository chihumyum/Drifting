import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseAndValidateGoogleDrivePhysicalEvidence,
  validateGoogleDrivePhysicalEvidence,
} from '../../../scripts/check-google-drive-physical-evidence';

const template = JSON.parse(
  readFileSync(path.resolve('docs/qa/google-drive-physical-evidence.template.json'), 'utf8'),
) as Record<string, unknown>;

function passingReport(): Record<string, unknown> {
  const report = structuredClone(template) as {
    recordedAt: string;
    sourceCommit: string;
    appVersion: string;
    artifacts: Record<
      string,
      {
        sourceCommit: string;
        artifactSha256: string;
        systemVersion: string;
        signed: boolean;
        physical: boolean;
      }
    >;
    scenarios: Array<{ id: string; result: string; evidenceSha256: string[] }>;
  };
  report.recordedAt = '2026-08-23T15:30:00.000Z';
  report.sourceCommit = 'a'.repeat(40);
  report.appVersion = '0.1.0-alpha.1';
  Object.values(report.artifacts).forEach((artifact, index) => {
    artifact.sourceCommit = report.sourceCommit;
    artifact.artifactSha256 = String(index + 1).repeat(64);
    artifact.systemVersion = '26.1 (Build-1)';
    artifact.signed = true;
    artifact.physical = true;
  });
  report.scenarios.forEach((scenario, index) => {
    scenario.result = 'pass';
    scenario.evidenceSha256 = [((index % 15) + 1).toString(16).repeat(64)];
  });
  return report as unknown as Record<string, unknown>;
}

describe('Google Drive physical evidence validator', () => {
  it('accepts the open template only in contract mode', () => {
    expect(() => validateGoogleDrivePhysicalEvidence(template, { allowOpen: true })).not.toThrow();
    expect(() => validateGoogleDrivePhysicalEvidence(template)).toThrow(/appVersion|placeholder/u);
  });

  it('accepts only a complete signed three-platform matrix', () => {
    const report = passingReport();
    expect(validateGoogleDrivePhysicalEvidence(report).scenarios).toHaveLength(40);
  });

  it('rejects source drift, missing rows, open rows and pass rows without evidence', () => {
    const sourceDrift = passingReport();
    (
      sourceDrift.artifacts as Record<string, { sourceCommit: string }>
    ).ios.sourceCommit = 'b'.repeat(40);
    expect(() => validateGoogleDrivePhysicalEvidence(sourceDrift)).toThrow(/does not match/u);

    const versionDrift = passingReport();
    versionDrift.appVersion = '9.9.9';
    expect(() => validateGoogleDrivePhysicalEvidence(versionDrift)).toThrow(/appVersion/u);

    const missing = passingReport();
    (missing.scenarios as unknown[]).pop();
    expect(() => validateGoogleDrivePhysicalEvidence(missing)).toThrow(/missing/u);

    const open = passingReport();
    (open.scenarios as Array<{ result: string }>)[0].result = 'not-run';
    expect(() => validateGoogleDrivePhysicalEvidence(open)).toThrow(/not passed/u);

    const digestless = passingReport();
    (digestless.scenarios as Array<{ evidenceSha256: string[] }>)[0].evidenceSha256 = [];
    expect(() => validateGoogleDrivePhysicalEvidence(digestless)).toThrow(/no evidence digest/u);
  });

  it('rejects free-form fields and credential, account, URL, or path shapes before parsing', () => {
    const unknownField = passingReport();
    unknownField.notes = 'free form';
    expect(() => validateGoogleDrivePhysicalEvidence(unknownField)).toThrow(/unapproved fields/u);

    for (const unsafe of [
      'writer@example.com',
      '/Users/example/private.json',
      'https://example.com/session',
      'ya29.not-a-real-token',
      '123.apps.googleusercontent.com',
    ]) {
      const raw = JSON.stringify({ ...passingReport(), unsafe });
      expect(() => parseAndValidateGoogleDrivePhysicalEvidence(raw)).toThrow(/forbidden/u);
    }
  });
});
