import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { getConnection } from '../db/connection.js';
import { getDefaultConfig, saveConfig } from '../utils/config.js';

export interface InitOptions {
  name?: string;
  hook?: boolean;
}

export function init(options: InitOptions = {}): string {
  const cwd = process.cwd();
  const nousDir = join(cwd, '.nous');

  if (existsSync(join(nousDir, 'knowledge.db'))) {
    return `nous is already initialized in ${nousDir}`;
  }

  // Create .nous directory
  mkdirSync(nousDir, { recursive: true });

  // Create .gitignore for WAL/journal files
  writeFileSync(
    join(nousDir, '.gitignore'),
    '*.db-wal\n*.db-shm\n*.db-journal\n',
  );

  // Determine project name
  const projectName = options.name ?? basename(resolve(cwd));

  // Create config
  const config = getDefaultConfig(projectName);
  saveConfig(nousDir, config);

  // Initialize database (creates schema)
  const dbPath = join(nousDir, 'knowledge.db');
  const db = getConnection(dbPath);

  // Set project name in metadata
  db.prepare('UPDATE nous_meta SET value = ? WHERE key = ?').run(projectName, 'project_name');

  db.close();

  // Add .gitattributes entry for binary merge strategy
  const gitattributesPath = join(cwd, '.gitattributes');
  const gitattributesEntry = '.nous/knowledge.db binary merge=binary\n';

  if (existsSync(gitattributesPath)) {
    const existing = readFileSync(gitattributesPath, 'utf-8');
    if (!existing.includes('.nous/knowledge.db')) {
      writeFileSync(gitattributesPath, existing + gitattributesEntry);
    }
  } else {
    writeFileSync(gitattributesPath, gitattributesEntry);
  }

  // Optionally install Claude Code hook
  if (options.hook) {
    installClaudeCodeHook(cwd);
  }

  return `nous initialized for "${projectName}" in ${nousDir}`;
}

function installClaudeCodeHook(projectDir: string): void {
  const claudeDir = join(projectDir, '.claude');
  mkdirSync(claudeDir, { recursive: true });

  const settingsPath = join(claudeDir, 'settings.json');
  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(raw);
  }

  // Add hook for auto-extraction
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const postToolUse = (hooks.PostToolUse ?? []) as Record<string, unknown>[];

  // Check if hook already exists
  const alreadyInstalled = postToolUse.some(
    (h) => JSON.stringify(h).includes('nous extract'),
  );

  if (!alreadyInstalled) {
    postToolUse.push({
      matcher: { tool_name: 'Write|Edit' },
      hooks: [
        {
          type: 'command',
          command: 'nous extract --stdin --auto-save --source claude-code',
        },
      ],
    });
    hooks.PostToolUse = postToolUse;
    settings.hooks = hooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
}
