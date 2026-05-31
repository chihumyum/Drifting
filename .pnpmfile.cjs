/**
 * pnpm resolution hook.
 *
 * Strips the Claude Agent SDK's per-platform native-binary packages
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`) from its
 * optionalDependencies so pnpm never resolves / fetches / hashes them. Each is
 * a single ~206MB executable, and pnpm OOMs in a worker thread while hashing it
 * into its content-addressable store ("invalid array length" — V8's max
 * single-allocation limit, unfixable by raising the heap).
 *
 * The matching binary is installed instead by `scripts/fetch-claude-binary.mjs`
 * (wired as `postinstall`), which downloads + extracts it without any
 * Node-side hashing of the big file.
 */
function readPackage(pkg) {
  if (pkg.name === '@anthropic-ai/claude-agent-sdk' && pkg.optionalDependencies) {
    for (const dep of Object.keys(pkg.optionalDependencies)) {
      if (dep.startsWith('@anthropic-ai/claude-agent-sdk-')) {
        delete pkg.optionalDependencies[dep];
      }
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
