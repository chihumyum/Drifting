import { describe, expect, it, vi } from 'vitest';

// @ts-expect-error The executable Node selector intentionally lives outside the renderer TS graph.
import * as signingSelector from '../../../scripts/select-macos-dev-signing-identity.mjs';

const { parseSigningIdentities, selectVerifiedSigningIdentity } = signingSelector;

const oldFingerprint = '1111111111111111111111111111111111111111';
const newFingerprint = '2222222222222222222222222222222222222222';
const label = 'Apple Development: Example Developer (TEAM123456)';

function candidates() {
  return {
    identities: [
      { fingerprint: oldFingerprint, label },
      { fingerprint: newFingerprint, label },
    ],
    certificatesByFingerprint: new Map([
      [
        oldFingerprint,
        { fingerprint: oldFingerprint, validToMs: 1, raw: Buffer.alloc(0) },
      ],
      [
        newFingerprint,
        { fingerprint: newFingerprint, validToMs: 2, raw: Buffer.alloc(0) },
      ],
    ]),
  };
}

describe('macOS development signing identity selection', () => {
  it('keeps Apple Development identities and rejects locally flagged or unrelated entries', () => {
    const identities = parseSigningIdentities(
      [
        `  1) ${oldFingerprint} "${label}"`,
        '  2) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Developer ID Application: Example"',
        '  3) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB ' +
          '"Apple Development: Revoked" (CSSMERR_TP_CERT_REVOKED)',
        '     2 valid identities found',
      ].join('\n'),
    );

    expect(identities).toEqual([{ fingerprint: oldFingerprint, label }]);
  });

  it('prefers the newest certificate after required verification succeeds', () => {
    const verifyCertificate = vi.fn((_candidate: { fingerprint: string }) => ({
      ok: true,
    }));

    const selected = selectVerifiedSigningIdentity({
      ...candidates(),
      verifyCertificate,
    });

    expect(selected).toBe(newFingerprint);
    expect(verifyCertificate).toHaveBeenCalledTimes(1);
    expect(verifyCertificate.mock.calls[0]?.[0].fingerprint).toBe(newFingerprint);
  });

  it('skips a revoked newer certificate and selects an older verified certificate', () => {
    const verifyCertificate = vi.fn((candidate: { fingerprint: string }) =>
      candidate.fingerprint === newFingerprint
        ? { ok: false, reason: 'certificate is revoked' }
        : { ok: true },
    );

    const selected = selectVerifiedSigningIdentity({
      ...candidates(),
      verifyCertificate,
    });

    expect(selected).toBe(oldFingerprint);
    expect(verifyCertificate.mock.calls.map(([candidate]) => candidate.fingerprint)).toEqual([
      newFingerprint,
      oldFingerprint,
    ]);
  });

  it('fails closed when an explicitly pinned certificate is revoked', () => {
    const verifyCertificate = vi.fn(() => ({ ok: false, reason: 'certificate is revoked' }));

    expect(() =>
      selectVerifiedSigningIdentity({
        ...candidates(),
        requestedIdentity: newFingerprint.toLowerCase(),
        verifyCertificate,
      }),
    ).toThrow(/requested.*failed required OCSP revocation checking/iu);
    expect(verifyCertificate).toHaveBeenCalledTimes(1);
  });
});
