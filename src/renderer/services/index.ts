/**
 * Service surface for the renderer.
 *
 * Domain CRUD is owned by usecases and the provider-neutral SyncEngine
 * authored-transaction journal. Yjs local durability lives in
 * yjs-local-durability.service. Auth is handled directly via lib/auth-client.
 */

export * from './yjs-local-durability.service';
