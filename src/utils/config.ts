import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface NousConfig {
  project_name: string;
  embedding_model: string;
  embedding_dimensions: number;
  openai_api_key?: string;
  anthropic_api_key?: string;
  auto_extract: boolean;
  extraction_confidence: number;
}

const DEFAULT_CONFIG: NousConfig = {
  project_name: '',
  embedding_model: 'text-embedding-3-small',
  embedding_dimensions: 1536,
  auto_extract: false,
  extraction_confidence: 0.6,
};

/**
 * Walk up from startDir to find the .nous/ directory.
 * Returns the path to .nous/ or null if not found.
 */
export function findNousDir(startDir?: string): string | null {
  let dir = resolve(startDir ?? process.cwd());
  const root = resolve('/');

  while (dir !== root) {
    const candidate = join(dir, '.nous');
    if (existsSync(join(candidate, 'knowledge.db')) || existsSync(join(candidate, 'config.json'))) {
      return candidate;
    }
    dir = resolve(dir, '..');
  }

  return null;
}

/**
 * Get the path to knowledge.db, searching up from cwd.
 */
export function getDbPath(startDir?: string): string | null {
  const nousDir = findNousDir(startDir);
  return nousDir ? join(nousDir, 'knowledge.db') : null;
}

export function loadConfig(nousDir: string): NousConfig {
  const configPath = join(nousDir, 'config.json');

  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  const raw = readFileSync(configPath, 'utf-8');
  return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
}

export function saveConfig(nousDir: string, config: NousConfig): void {
  const configPath = join(nousDir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

export function getDefaultConfig(projectName: string): NousConfig {
  return { ...DEFAULT_CONFIG, project_name: projectName };
}
