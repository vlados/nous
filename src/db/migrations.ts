import type Database from 'better-sqlite3';

interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

/**
 * Future migrations go here. Schema v1 is created by initializeSchema().
 * Migrations handle incremental changes for databases created at older versions.
 */
const migrations: Migration[] = [
  // Example for future use:
  // {
  //   version: 2,
  //   description: 'Add importance column to knowledge',
  //   up: (db) => {
  //     db.exec(`ALTER TABLE knowledge ADD COLUMN importance TEXT DEFAULT 'normal'`);
  //   },
  // },
];

export function runMigrations(db: Database.Database): void {
  const currentVersion = getCurrentVersion(db);

  const pending = migrations.filter((m) => m.version > currentVersion);
  if (pending.length === 0) return;

  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      db.prepare('UPDATE nous_meta SET value = ? WHERE key = ?').run(
        String(migration.version),
        'schema_version',
      );
    })();
  }
}

function getCurrentVersion(db: Database.Database): number {
  try {
    const row = db
      .prepare('SELECT value FROM nous_meta WHERE key = ?')
      .get('schema_version') as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    return 0;
  }
}
