export const AGENT_USER_CHECKPOINT_CONTRACT = {
  authority: 'sqlite-user-checkpoint-plus-live-yjs',
  automaticBoundary: 'before-agent-tool-execution',
  conversationFork: 'new-route-with-durable-checkpoint-context',
  preview: 'durable-one-use-token-plus-all-entity-hash-witness',
  overwritePolicy: 'explicit-preview-confirmation-only',
  concurrencyPolicy: 'compare-and-set-before-each-write-and-final-verification',
  multiEntityAtomicity: 'durable-saga-with-reverse-compensation',
  restartRecovery: 'compensate-incomplete-with-author-edit-precedence',
  proseVerification: 'canonical-content-hash-not-yjs-binary-identity',
  capturedContext:
    'conversation-provider-history-long-task-accepted-writes-yjs-revision-state-vector',
  manuscriptScope: 'node-element-storyline-category-prose-and-restorable-metadata',
} as const;
