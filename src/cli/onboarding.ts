import { basename, resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { ask, confirm, select } from './prompt.js';
import { detectSources } from '../import/sources.js';

export interface OnboardingResult {
  projectName: string;
  embeddingProvider: 'openai' | 'none';
  apiKey: string | null;
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

  // 2. Embedding provider
  const embeddingProvider = await select('  Enable semantic search with AI embeddings?', [
    { label: 'OpenAI (text-embedding-3-small) — best quality, requires API key', value: 'openai' },
    { label: 'No embeddings — keyword search only (works great, zero cost)', value: 'none' },
  ]);

  // 3. API key (if OpenAI selected)
  let apiKey: string | null = null;
  if (embeddingProvider === 'openai') {
    const envKey = process.env['OPENAI_API_KEY'];
    if (envKey) {
      const useEnv = await confirm(`\n  Found OPENAI_API_KEY in environment. Use it?`, true);
      if (useEnv) {
        apiKey = envKey;
      }
    }

    if (!apiKey) {
      apiKey = await ask('\n  OpenAI API key (sk-...)');
      if (!apiKey || !apiKey.startsWith('sk-')) {
        console.log('  No valid key provided — semantic search disabled. You can add it later in .nous/config.json');
        apiKey = null;
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
    console.log('  The brain will learn from your conversations automatically.\n');
  }

  return {
    projectName,
    embeddingProvider: embeddingProvider as 'openai' | 'none',
    apiKey,
    importFiles,
    installHook,
  };
}
