/**
 * API Services Index
 *
 * The real HTTP routing for entity CRUD lives in
 * `services/entity-sync.service.ts:resolveMutationRequest`.
 * Only debug-api remains as a hand-written wrapper because the
 * DebugModal calls it directly.
 */

export * from './debug-api';
