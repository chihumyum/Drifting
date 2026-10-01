/** Native-authorized inbound connections. Tokens never enter the renderer. */
export type McpClient = 'codex' | 'claude_code';

export interface McpServerGrant {
  id: string;
  name: string;
  projectId: string;
  access: 'read' | 'write';
  allowDangerous: boolean;
  installation?: { client: McpClient; configPath: string; serverName: string };
}

export type McpServerCreateInput = Omit<McpServerGrant, 'id' | 'installation'>;
export type McpServerPermissionInput = Pick<McpServerGrant, 'id' | 'access' | 'allowDangerous'>;

export interface McpServerConnection {
  grant: McpServerGrant;
  config: { command: string; args: string[] };
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
  | { type: 'grantChanged'; grant: McpServerGrant }
  | { type: 'cancel'; requestId: string }
  | { type: 'closed'; sessionId: string };

export interface McpServerPlatformApi {
  list(): Promise<McpServerConnection[]>;
  create(input: McpServerCreateInput): Promise<McpServerConnection>;
  connect(input: McpServerCreateInput, client: McpClient): Promise<McpServerConnection>;
  updatePermission(input: McpServerPermissionInput): Promise<McpServerConnection>;
  revoke(id: string): Promise<string | null>;
  attach(projectId: string, onEvent: (event: McpServerEvent) => void): Promise<string>;
  detach(epoch: string): Promise<void>;
  complete(epoch: string, requestId: string, response: unknown): Promise<void>;
}
