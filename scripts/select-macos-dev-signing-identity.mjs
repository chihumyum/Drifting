#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const APPLE_DEVELOPMENT_PREFIX = 'Apple Development:';
const SHA1_HEX_PATTERN = /^[a-f\d]{40}$/iu;
const PEM_CERTIFICATE_PATTERN =
  /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu;

function normalizeFingerprint(value) {
  return value.replaceAll(':', '').trim().toUpperCase();
}

function commandResult(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
}

function commandDiagnostic(result) {
  const diagnostic = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
    .replaceAll(/\u001b\[[\d;]*m/gu, '')
    .trim();
  return diagnostic || `command exited with status ${result.status ?? 'unknown'}`;
}

export function parseSigningIdentities(output) {
  const identities = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^\s*\d+\)\s+([a-f\d]{40})\s+"([^"]+)"/iu);
    if (!match || line.includes('CSSMERR_')) continue;
    const [, fingerprint, label] = match;
    if (!label.startsWith(APPLE_DEVELOPMENT_PREFIX)) continue;
    identities.push({
      fingerprint: normalizeFingerprint(fingerprint),
      label,
    });
  }
  return identities;
}

export function parseIdentityCertificates(pemBundle) {
  const certificates = new Map();
  for (const pem of pemBundle.match(PEM_CERTIFICATE_PATTERN) ?? []) {
    const certificate = new X509Certificate(pem);
    const fingerprint = normalizeFingerprint(certificate.fingerprint);
    certificates.set(fingerprint, {
      fingerprint,
      raw: certificate.raw,
      validToMs: Date.parse(certificate.validTo),
    });
  }
  return certificates;
}

function requestedCandidates(candidates, requestedIdentity) {
  const requested = requestedIdentity?.trim();
  if (!requested) return candidates;

  const normalizedRequest = normalizeFingerprint(requested);
  if (SHA1_HEX_PATTERN.test(normalizedRequest)) {
    return candidates.filter((candidate) => candidate.fingerprint === normalizedRequest);
  }
  return candidates.filter((candidate) => candidate.label === requested);
}

export function selectVerifiedSigningIdentity({
  identities,
  certificatesByFingerprint,
  requestedIdentity,
  verifyCertificate,
}) {
  const seen = new Set();
  const candidates = identities
    .filter((identity) => {
      if (seen.has(identity.fingerprint)) return false;
      seen.add(identity.fingerprint);
      return true;
    })
    .map((identity) => ({
      ...identity,
      certificate: certificatesByFingerprint.get(identity.fingerprint),
    }))
    .filter((candidate) => candidate.certificate)
    .sort(
      (left, right) =>
        right.certificate.validToMs - left.certificate.validToMs ||
        left.fingerprint.localeCompare(right.fingerprint),
    );

  const eligible = requestedCandidates(candidates, requestedIdentity);
  if (eligible.length === 0) {
    const qualifier = requestedIdentity?.trim()
      ? ` matching DRIFTING_MACOS_DEV_SIGNING_IDENTITY=${requestedIdentity.trim()}`
      : '';
    throw new Error(`No Apple Development code-signing identity${qualifier} was found.`);
  }

  const rejected = [];
  for (const candidate of eligible) {
    const verification = verifyCertificate(candidate);
    if (verification.ok) return candidate.fingerprint;
    rejected.push(`${candidate.fingerprint}: ${verification.reason}`);
  }

  const qualifier = requestedIdentity?.trim() ? 'The requested' : 'Every available';
  throw new Error(
    `${qualifier} Apple Development identity failed required OCSP revocation checking.\n` +
      rejected.map((reason) => `- ${reason}`).join('\n'),
  );
}

export function resolveMacosDevSigningIdentity({
  requestedIdentity = process.env.DRIFTING_MACOS_DEV_SIGNING_IDENTITY,
  runCommand = commandResult,
} = {}) {
  const identityResult = runCommand('security', ['find-identity', '-v', '-p', 'codesigning']);
  if (identityResult.status !== 0) {
    throw new Error(
      `Unable to query macOS code-signing identities: ${commandDiagnostic(identityResult)}`,
    );
  }

  const identities = parseSigningIdentities(identityResult.stdout ?? '');
  if (identities.length === 0) {
    throw new Error('No Apple Development code-signing identity with a private key was found.');
  }

  const certificatesByFingerprint = new Map();
  for (const label of new Set(identities.map((identity) => identity.label))) {
    const certificateResult = runCommand('security', [
      'find-certificate',
      '-a',
      '-c',
      label,
      '-p',
    ]);
    if (certificateResult.status !== 0) {
      throw new Error(
        `Unable to inspect Apple Development certificate ${label}: ${commandDiagnostic(certificateResult)}`,
      );
    }
    for (const [fingerprint, certificate] of parseIdentityCertificates(
      certificateResult.stdout ?? '',
    )) {
      certificatesByFingerprint.set(fingerprint, certificate);
    }
  }

  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'drifting-dev-signing-'));
  try {
    return selectVerifiedSigningIdentity({
      identities,
      certificatesByFingerprint,
      requestedIdentity,
      verifyCertificate(candidate) {
        const certificatePath = path.join(temporaryDirectory, `${candidate.fingerprint}.cer`);
        writeFileSync(certificatePath, candidate.certificate.raw);
        const verification = runCommand('security', [
          'verify-cert',
          '-c',
          certificatePath,
          '-p',
          'codeSign',
          '-R',
          'ocsp',
          '-R',
          'require',
          '-q',
        ]);
        return verification.status === 0
          ? { ok: true }
          : { ok: false, reason: commandDiagnostic(verification) };
      },
    });
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function runCli() {
  if (process.platform !== 'darwin') {
    throw new Error(`macOS development signing is unavailable on ${process.platform}.`);
  }
  process.stdout.write(`${resolveMacosDevSigningIdentity()}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
