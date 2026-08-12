/**
 * Vite injects `import.meta.env` in renderer builds. Node/headless developer
 * tooling imports part of the same domain graph without that transform, so
 * shared non-UI modules must read through this empty-default adapter.
 */
export const runtimeViteEnv =
  import.meta.env ?? {};
