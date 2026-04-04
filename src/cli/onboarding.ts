import { basename, resolve } from 'node:path';
import { ask, confirm, select } from './prompt.js';
import { detectSources } from '../import/sources.js';

export interface OnboardingResult {
  projectName: string;
  embeddingProvider: 'openai' | 'none';
  openaiKey: string | null;
  anthropicKey: string | null;
  importFiles: boolean;
  installHook: boolean;
}

export async function runOnboarding(): Promise<OnboardingResult> {
  const cwd = process.cwd();
  const defaultName = basename(resolve(cwd));

  console.log('\n  nous — project knowledge brain\n');
  console.log('  Let\'s set up your project brain.\n');

  // 1. Project name
  const projectName = await ask('  Project name', defaultName);

  // 2. Anthropic API key (for AI-powered extraction)
  let anthropicKey: string | null = null;
  const envAnthropicKey = process.env['ANTHROPIC_API_KEY'];

  console.log('');
  console.log('  nous uses Claude to understand your conversations and extract');
  console.log('  knowledge automatically (decisions, patterns, architecture).');
  console.log('');

  if (envAnthropicKey) {
    const useEnv = await confirm('  Found ANTHROPIC_API_KEY in environment. Use it?', true);
    if (useEnv) {
      anthropicKey = envAnthropicKey;
    }
  }

  if (!anthropicKey) {
    anthropicKey = await ask('  Anthropic API key (sk-ant-..., Enter to skip)');
    if (anthropicKey && !anthropicKey.startsWith('sk-ant-')) {
      console.log('  Skipped — will use heuristic extraction (regex patterns).');
      anthropicKey = null;
    }
  }

  if (anthropicKey) {
    console.log('  AI-powered extraction enabled (Claude Haiku).');
  }

  // 3. Embedding provider (for semantic search)
  const embeddingProvider = await select('\n  Enable semantic search?', [
    { label: 'OpenAI embeddings — "how do we handle payments" finds "Stripe webhook flow"', value: 'openai' },
    { label: 'Keyword search only — fast, free, works great for exact terms', value: 'none' },
  ]);

  let openaiKey: string | null = null;
  if (embeddingProvider === 'openai') {
    const envOpenaiKey = process.env['OPENAI_API_KEY'];
    if (envOpenaiKey) {
      const useEnv = await confirm('\n  Found OPENAI_API_KEY in environment. Use it?', true);
      if (useEnv) {
        openaiKey = envOpenaiKey;
      }
    }

    if (!openaiKey) {
      openaiKey = await ask('\n  OpenAI API key (sk-..., Enter to skip)');
      if (openaiKey && !openaiKey.startsWith('sk-')) {
        console.log('  Skipped — using keyword search only.');
        openaiKey = null;
      }
    }
  }

  // 4. Import existing files
  const sources = detectSources(cwd);
  let importFiles = false;
  if (sources.length > 0) {
    console.log(`\n  Found ${sources.length} knowledge source${sources.length > 1 ? 's' : ''}:`);
    for (const s of sources) {
      console.log(`    - ${s.name}`);
    }
    importFiles = await confirm('\n  Import them into the brain?', true);
  }

  // 5. Auto-learning hook
  const installHook = await confirm('\n  Install auto-learning hook for Claude Code?', true);
  if (installHook) {
    console.log('  Your conversations will teach the brain automatically.');
  }

  return {
    projectName,
    embeddingProvider: embeddingProvider as 'openai' | 'none',
    openaiKey,
    anthropicKey,
    importFiles,
    installHook,
  };
}
