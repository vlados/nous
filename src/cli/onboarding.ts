import { basename, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ask, confirm, select } from './prompt.js';
import { detectSources } from '../import/sources.js';
import { loadConfig } from '../utils/config.js';

export interface OnboardingResult {
  projectName: string;
  openaiKey: string | null;
  anthropicKey: string | null;
  importFiles: boolean;
  installHook: boolean;
}

export async function runOnboarding(): Promise<OnboardingResult> {
  const cwd = process.cwd();
  const defaultName = basename(resolve(cwd));
  const nousDir = join(cwd, '.nous');
  const alreadyExists = existsSync(join(nousDir, 'knowledge.db'));

  console.log('\n  nous — project knowledge brain\n');

  if (alreadyExists) {
    const config = loadConfig(nousDir);
    console.log(`  Brain exists for "${config.project_name}" (${nousDir})`);
    console.log('  Updating configuration...\n');
  } else {
    console.log('  Let\'s set up your project brain.\n');
  }

  // 1. Project name (skip if already exists)
  const projectName = alreadyExists
    ? loadConfig(nousDir).project_name || defaultName
    : await ask('  Project name', defaultName);

  // 2. API Keys
  console.log('\n  API Keys');
  console.log('  ────────────────────────────────────────');

  // Anthropic — for AI extraction
  let anthropicKey: string | null = null;
  const envAnthropicKey = process.env['ANTHROPIC_API_KEY'];

  console.log('');
  console.log('  Anthropic API key → AI-powered knowledge extraction');
  console.log('  Claude reads your conversations and extracts decisions,');
  console.log('  patterns, and architecture knowledge automatically.');
  console.log('');

  if (envAnthropicKey) {
    const useEnv = await confirm('  Found ANTHROPIC_API_KEY in environment. Use it?', true);
    if (useEnv) anthropicKey = envAnthropicKey;
  }

  if (!anthropicKey) {
    anthropicKey = await ask('  Anthropic API key (Enter to skip)');
    if (anthropicKey && !anthropicKey.startsWith('sk-ant-')) {
      console.log('  Skipped — will use heuristic extraction (regex patterns).');
      anthropicKey = null;
    }
  }

  if (anthropicKey) {
    console.log('  AI extraction enabled.');
  }

  // OpenAI — for semantic search
  let openaiKey: string | null = null;
  const envOpenaiKey = process.env['OPENAI_API_KEY'];

  console.log('');
  console.log('  OpenAI API key → semantic search');
  console.log('  "how do we handle payments" finds "Stripe webhook flow"');
  console.log('  Without it, keyword search still works great.');
  console.log('');

  if (envOpenaiKey) {
    const useEnv = await confirm('  Found OPENAI_API_KEY in environment. Use it?', true);
    if (useEnv) openaiKey = envOpenaiKey;
  }

  if (!openaiKey) {
    openaiKey = await ask('  OpenAI API key (Enter to skip)');
    if (openaiKey && !openaiKey.startsWith('sk-')) {
      console.log('  Skipped — using keyword search only.');
      openaiKey = null;
    }
  }

  if (openaiKey) {
    console.log('  Semantic search enabled.');
  }

  // 3. Import existing files (skip if already exists — they're likely imported)
  let importFiles = false;
  if (!alreadyExists) {
    const sources = detectSources(cwd);
    if (sources.length > 0) {
      console.log(`\n  Found ${sources.length} knowledge source${sources.length > 1 ? 's' : ''}:`);
      for (const s of sources) {
        console.log(`    - ${s.name}`);
      }
      importFiles = await confirm('\n  Import them into the brain?', true);
    }
  }

  // 4. Auto-learning hook
  const installHook = await confirm('\n  Install auto-learning hook for Claude Code?', true);
  if (installHook) {
    console.log('  Your conversations will teach the brain automatically.');
  }

  return {
    projectName,
    openaiKey,
    anthropicKey,
    importFiles,
    installHook,
  };
}
