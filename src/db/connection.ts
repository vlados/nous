import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { initializeSchema } from './schema.js';
import { runMigrations } from './migrations.js';

let instance: Database.Database | null = null;

export function getConnection(dbPath: string): Database.Database {
  if (instance && instance.open) {
    return instance;
  }

  const db = new Database(dbPath);

  // Core pragmas
  db.pragma('journal_mode = DELETE'); // No WAL sidecar files — git-friendly
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // Load sqlite-vec extension
  sqliteVec.load(db);

  // Initialize schema (idempotent — uses IF NOT EXISTS)
  initializeSchema(db);

  // Run any pending migrations
  runMigrations(db);

  instance = db;
  return db;
}

export function closeConnection(): void {
  if (instance && instance.open) {
    instance.close();
    instance = null;
  }
}

/**
 * Create an in-memory database for testing.
 * Returns a fresh connection each time.
 */
export function getTestConnection(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  initializeSchema(db);
  runMigrations(db);
  return db;
}
