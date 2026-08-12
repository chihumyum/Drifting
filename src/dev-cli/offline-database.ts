import { ProductFileBackedSqliteGateway } from '../renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import {
  createDatabaseClient,
  installHeadlessDatabaseClient,
  type DbClient,
} from '../renderer/lib/db';

export class OfflineProductDatabase {
  readonly gateway: ProductFileBackedSqliteGateway;
  readonly client: DbClient;
  private releaseHeadlessClient: (() => void) | null = null;

  constructor(
    readonly path: string,
    options: { migrate: boolean },
  ) {
    this.gateway = new ProductFileBackedSqliteGateway(path, options.migrate, {
      deferRootRequestsDuringTransaction: true,
    });
    this.client = createDatabaseClient(this.gateway);
  }

  async open(): Promise<void> {
    await this.gateway.open(this.path);
    this.releaseHeadlessClient = installHeadlessDatabaseClient(this.client, this.path);
  }

  async close(): Promise<void> {
    this.releaseHeadlessClient?.();
    this.releaseHeadlessClient = null;
    await this.gateway.close();
  }
}
