/**
 * Service surface for the renderer.
 *
 * Entity CRUD goes through the outbox in entity-sync.service. Yjs document
 * sync lives in yjs-sync.service. Auth is handled directly via
 * lib/auth-client, not from this barrel.
 */

export * from './entity-sync.service';
export * from './yjs-sync.service';
