import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const root = fileURLToPath(new URL('../../..', import.meta.url));
function validate(mutation = '') {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { validateStartupFailure } from './scripts/renderer-startup-contract.mjs';
    const report = {schemaVersion:1,kind:'renderer_native_startup_failure',status:'failed',measurementStatus:'incomplete',shutdown:'not-accepted',
      source:{fingerprint:'a'.repeat(64)},artifact:{sha256:'b'.repeat(64),build:'packaged-release-production-renderer',signed:false},
      fixture:{reproducible:true,freshCopyPerLaunch:true},attemptIndex:0,completedSamples:0,
      failure:{status:'failed',message:'Synthetic focus failure',observedAtMs:100,focused:false,visibility:'visible',activeElement:'BODY',
        failures:[],marks:[],nativeWindow:{focused:true,visible:true},focusTransitions:[]}};
    ${mutation}
    validateStartupFailure(report);
  `], {cwd:root,encoding:'utf8'});
}
it('records native and WebView focus independently without passing claims', () => expect(validate().status).toBe(0));
it('retains a failed diagnostic query as an error', () => expect(validate('report.failure.nativeWindow = {error:"Synthetic denied query"};').status).toBe(0));
it.each([
  ['passing claim', 'report.status="passed";'],
  ['normal shutdown claim', 'report.shutdown="accepted";'],
  ['fabricated summary', 'report.summary={};'],
  ['incomplete series treated as complete', 'report.completedSamples=6;'],
  ['unbounded trace', 'report.failure.focusTransitions=Array(33).fill({event:"blur",atMs:1,focused:false,visibility:"visible"});'],
  ['missing document state', 'delete report.failure.focused;'],
  ['missing native state', 'report.failure.nativeWindow={};'],
  ['invalid observation time', 'report.failure.observedAtMs=-1;'],
])('rejects %s', (_label, mutation) => expect(validate(mutation).status).not.toBe(0));
