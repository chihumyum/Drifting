// Preloaded by the element acceptance oracle (`--import`). The renderer KV
// authority mints new kv-entry IDs with uuidv7; natively they are host IDs.
// Only `uuid` imported by normalized-kv-alias-authority.ts resolves to this
// queue, which the check arms per step with the created kv-entry IDs of the
// native original (in mutation order) and requires to be drained exactly.
import { registerHooks } from 'node:module';

const shim = 'drifting-acceptance:kv-entry-ids';
const importer = '/src/renderer/usecase/normalized-kv-alias-authority.ts';
const source = `
const key = Symbol.for('drifting.acceptance.kvEntryIds');
export function v7(...args) {
  const queue = globalThis[key];
  if (args.length > 0 || !Array.isArray(queue) || queue.length === 0) {
    throw new Error('No native kv-entry ID is armed for the renderer KV authority');
  }
  return queue.shift();
}
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ? new URL(context.parentURL) : null;
    if (specifier === 'uuid' && parent?.protocol === 'file:' && parent.pathname.endsWith(importer)) {
      return { url: shim, format: 'module', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    return url === shim ? { format: 'module', source, shortCircuit: true } : nextLoad(url, context);
  },
});
