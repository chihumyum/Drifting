/** Native-authorized inbound connections. Tokens never enter the renderer. */
export type McpClient = 'codex' | 'claude_code' | 'antigravity';

export interface McpServerGrant {
  id: string;
  name: string;
  /** Only on a connection made for one book before connections reached
   *  whichever book is open; it stays limited to that book until revoked. */
  projectId?: string;
  installation?: { client: McpClient; configPath: string; serverName: string };
}

/** Every connection may use every tool the external surface offers. */
export type McpServerCreateInput = Pick<McpServerGrant, 'name'>;

export interface McpServerConnection {
  grant: McpServerGrant;
  config: { command: string; args: string[] };
  /** Connecting a client retired its book connections, and one of their
   *  entries could not be removed from the client's configuration. */
  leftover?: true;
}

export interface McpServerRequest {
  type: 'request';
  requestId: string;
  sessionId: string;
  epoch: string;
  grant: McpServerGrant;
  request: {
    jsonrpc: '2.0';
    id: string | number;
    method: string;
    params?: { name?: string; arguments?: Record<string, unknown>; cursor?: string };
  };
}

export type McpServerEvent =
  | McpServerRequest
  | { type: 'cancel'; requestId: string }
  | { type: 'closed'; sessionId: string };

export interface McpServerPlatformApi {
  list(): Promise<McpServerConnection[]>;
  create(input: McpServerCreateInput): Promise<McpServerConnection>;
  connect(input: McpServerCreateInput, client: McpClient): Promise<McpServerConnection>;
  revoke(id: string): Promise<string | null>;
  attach(projectId: string, onEvent: (event: McpServerEvent) => void): Promise<string>;
  detach(epoch: string): Promise<void>;
  complete(epoch: string, requestId: string, response: unknown): Promise<void>;
}
