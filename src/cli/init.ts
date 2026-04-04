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
    ``,
    `nous initialized for "${projectName}"`,
    '',
    'Created:',
    `  .nous/knowledge.db      — the brain (commit to git, share with team)`,
    `  .nous/config.json       — settings`,
    `  .claude/settings.json   — Claude Code will connect automatically`,
  ];

  if (options.hook) {
    lines.push(`  .claude/hooks/           — auto-learning from conversations`);
  }

  lines.push('');
  lines.push('Start Claude Code in this project — nous is ready, no extra setup.');
  lines.push('');
  lines.push('Teach it:');
  lines.push('  npx nousdb teach concept "Payment Flow" "Stripe webhooks → OrderService"');
  lines.push('  npx nousdb teach decision "Chose Redis" "For pub/sub over Memcached"');
  lines.push('  npx nousdb teach pattern "API Responses" "Always use ApiResponse wrapper"');
  if (!options.hook) {
    lines.push('');
    lines.push('Want auto-learning? Run: npx nousdb init --hook');
  }

  return lines.join('\n');
}

/**
 * Add nous as an MCP server in .claude/settings.json
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
 * Install auto-learning hook that reads the conversation transcript
 * after every Claude response and extracts knowledge.
 *
 * Uses the "Stop" event which fires when Claude finishes responding.
 * The transcript_path in stdin points to the full conversation JSONL.
 * Runs async so it doesn't block Claude.
 */
function installClaudeCodeHook(projectDir: string): void {
  const claudeDir = join(projectDir, '.claude');
  const hooksDir = join(claudeDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });

  // Create the extraction shell script
  const scriptPath = join(hooksDir, 'nous-extract.sh');
  const script = `#!/bin/bash
# nous auto-learning hook — extracts knowledge from Claude Code conversations
# Fires on "Stop" event (after every Claude response), runs async

INPUT=$(cat)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')

if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  exit 0
fi

# Read the last 20 conversation turns from the transcript
RECENT=$(tail -40 "$TRANSCRIPT" 2>/dev/null | jq -r 'select(.type == "text" or .type == "assistant") | .content // .text // empty' 2>/dev/null | tail -2000)

if [ -z "$RECENT" ]; then
  exit 0
fi

# Pipe to nous extract (auto-save with lower confidence)
echo "$RECENT" | npx nousdb extract --stdin --auto-save --source claude-code 2>/dev/null

exit 0
`;

  writeFileSync(scriptPath, script, { mode: 0o755 });

  // Add the Stop hook to settings.json
  const settingsPath = join(claudeDir, 'settings.json');
  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, 'utf-8');
      settings = JSON.parse(raw);
    } catch {}
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const stopHooks = (hooks.Stop ?? []) as Record<string, unknown>[];

  const alreadyInstalled = stopHooks.some(
    (h) => JSON.stringify(h).includes('nous-extract'),
  );

  if (!alreadyInstalled) {
    stopHooks.push({
      matcher: '',
      hooks: [
        {
          type: 'command',
          command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/nous-extract.sh',
          timeout: 30,
          async: true,
        },
      ],
    });
    hooks.Stop = stopHooks;
    settings.hooks = hooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
}
