export type CliOutputMode = 'json' | 'human';

export type CliSafetyTier = 'read' | 'write' | 'destructive' | 'excluded';

export type CliModelCoverage =
  | 'full_lifecycle'
  | 'workflow_only'
  | 'derived_rebuild'
  | 'inspect_reconcile'
  | 'excluded';

export interface CliModelCapability {
  name: string;
  scope: 'workspace' | 'agent' | 'server' | 'ops';
  authority: 'sqlite' | 'yjs_sqlite' | 'server' | 'derived' | 'secret_store';
  coverage: CliModelCoverage;
  commands: readonly string[];
  table?: string;
  note: string;
}

export interface CliEnvelope<T = unknown> {
  ok: boolean;
  command: string;
  requestId: string;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta: {
    durationMs: number;
    mode: 'offline' | 'bridge' | 'server' | 'local';
    projectId?: string;
    databasePath?: string;
    backupPath?: string;
  };
}

export interface ParsedCliInput {
  command: string[];
  flags: Record<string, string | boolean | string[]>;
  values: Record<string, unknown>;
}

export interface CliGlobalOptions {
  output: CliOutputMode;
  projectId?: string;
  databasePath?: string;
  baseUrl?: string;
  bridgeUrl?: string;
  cookieFile?: string;
  requestId: string;
  yes: boolean;
  offlineUserdata: boolean;
  stream: boolean;
}
