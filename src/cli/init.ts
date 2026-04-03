import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { getConnection, closeConnection } from '../db/connection.js';
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

  closeConnection();

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

  // Always add MCP server config for Claude Code
  installMcpServer(cwd);

  // Optionally install auto-learning hook
  if (options.hook) {
    installClaudeCodeHook(cwd);
  }

  const lines = [
    `nous initialized for "${projectName}"`,
    '',
    'What was set up:',
    `  .nous/knowledge.db     — knowledge brain (commit to git)`,
    `  .nous/config.json      — project settings`,
    `  .gitattributes         — binary merge strategy for .db`,
    `  .claude/settings.json  — MCP server config for Claude Code`,
  ];

  if (options.hook) {
    lines.push(`  .claude/settings.json  — auto-learning hook (PostToolUse)`);
  }

  lines.push('');
  lines.push('Next steps:');
  lines.push('  nous teach concept "How Auth Works" "JWT tokens with refresh rotation..."');
  lines.push('  nous teach decision "Chose Redis" "For pub/sub support over Memcached"');
  lines.push('  nous teach pattern "API Responses" "Always use ApiResponse wrapper"');
  lines.push('');
  lines.push('Claude Code can now query your brain via MCP automatically.');

  return lines.join('\n');
}

/**
 * Add nous as an MCP server in .claude/settings.json
 * so Claude Code can query the brain automatically.
 */
function installMcpServer(projectDir: string): void {
  const claudeDir = join(projectDir, '.claude');
  mkdirSync(claudeDir, { recursive: true });

  const settingsPath = join(claudeDir, 'settings.json');
  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, 'utf-8');
      settings = JSON.parse(raw);
    } catch {
      // Corrupted settings — start fresh
    }
  }

  const mcpServers = (settings.mcpServers ?? {}) as Record<string, unknown>;

  // Don't overwrite if already configured
  if (!mcpServers.nous) {
    mcpServers.nous = {
      type: 'stdio',
      command: 'npx',
      args: ['nousdb', 'serve'],
    };
    settings.mcpServers = mcpServers;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
}

/**
 * Add auto-learning hook that extracts knowledge from Claude Code conversations.
 */
function installClaudeCodeHook(projectDir: string): void {
  const settingsPath = join(projectDir, '.claude', 'settings.json');
  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(raw);
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const postToolUse = (hooks.PostToolUse ?? []) as Record<string, unknown>[];

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
