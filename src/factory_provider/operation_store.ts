import Database from "better-sqlite3";
import type { FactoryPrototypeOperation } from "./protocol";

export interface StoredPrototypeOperation {
  operation: FactoryPrototypeOperation;
  inputSha256: string;
  createdAt: string;
  updatedAt: string;
}

export class PrototypeOperationStore {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath, { timeout: 10_000 });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS factory_prototype_operations (
        operation_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        input_sha256 TEXT NOT NULL,
        operation_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  getByOperationId(operationId: string): StoredPrototypeOperation | null {
    const row = this.db
      .prepare(
        `SELECT operation_json, input_sha256, created_at, updated_at
         FROM factory_prototype_operations
         WHERE operation_id = ?`,
      )
      .get(operationId) as
      | {
          operation_json: string;
          input_sha256: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    return row ? this.decode(row) : null;
  }

  getByIdempotencyKey(idempotencyKey: string): StoredPrototypeOperation | null {
    const row = this.db
      .prepare(
        `SELECT operation_json, input_sha256, created_at, updated_at
         FROM factory_prototype_operations
         WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey) as
      | {
          operation_json: string;
          input_sha256: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    return row ? this.decode(row) : null;
  }

  create(
    operation: FactoryPrototypeOperation,
    inputSha256: string,
  ): StoredPrototypeOperation {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO factory_prototype_operations (
          operation_id,
          idempotency_key,
          input_sha256,
          operation_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operation.operationId,
        operation.idempotencyKey,
        inputSha256,
        JSON.stringify(operation),
        now,
        now,
      );
    return {
      operation,
      inputSha256,
      createdAt: now,
      updatedAt: now,
    };
  }

  update(operation: FactoryPrototypeOperation): StoredPrototypeOperation {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE factory_prototype_operations
         SET operation_json = ?, updated_at = ?
         WHERE operation_id = ?`,
      )
      .run(JSON.stringify(operation), now, operation.operationId);

    if (result.changes !== 1) {
      throw new Error(`unknown prototype operation: ${operation.operationId}`);
    }

    const stored = this.getByOperationId(operation.operationId);
    if (!stored) {
      throw new Error(`prototype operation disappeared: ${operation.operationId}`);
    }
    return stored;
  }

  private decode(row: {
    operation_json: string;
    input_sha256: string;
    created_at: string;
    updated_at: string;
  }): StoredPrototypeOperation {
    return {
      operation: JSON.parse(row.operation_json) as FactoryPrototypeOperation,
      inputSha256: row.input_sha256,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
