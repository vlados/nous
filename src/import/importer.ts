import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { EmbeddingEngine } from '../embeddings/engine.js';
import { KnowledgeRepository } from '../knowledge/repository.js';
import { KnowledgeSearch } from '../knowledge/search.js';
import type { CreateKnowledgeInput, KnowledgeEntry } from '../knowledge/types.js';
import {
  detectSources,
  parseClaudeMd,
  parseReadme,
  parseCursorRules,
  parseAdr,
  parseGenericMd,
  type ImportSource,
} from './sources.js';

export interface ImportResult {
  source: string;
  imported: number;
  skipped: number;
  entries: { title: string; type: string }[];
}

export class KnowledgeImporter {
  private repo: KnowledgeRepository;
  private search: KnowledgeSearch;

  constructor(
    private db: Database.Database,
    private embeddings: EmbeddingEngine,
  ) {
    this.repo = new KnowledgeRepository(db);
    this.search = new KnowledgeSearch(db, embeddings);
  }

  /**
   * Auto-detect and import all sources in the project.
   */
  async importAll(projectDir: string): Promise<ImportResult[]> {
    const sources = detectSources(projectDir);
    const results: ImportResult[] = [];

    for (const source of sources) {
      const result = await this.importSource(source);
      results.push(result);
    }

    return results;
  }

  /**
   * Import from a specific file path.
   */
  async importFile(filePath: string, type?: ImportSource['type']): Promise<ImportResult> {
    const sourceType = type ?? guessFileType(filePath);
    return this.importSource({ name: filePath, path: filePath, type: sourceType });
  }

  /**
   * Import from a detected source.
   */
  private async importSource(source: ImportSource): Promise<ImportResult> {
    let content: string;
    try {
      content = readFileSync(source.path, 'utf-8');
    } catch {
      return { source: source.name, imported: 0, skipped: 0, entries: [] };
    }

    if (content.trim().length < 20) {
      return { source: source.name, imported: 0, skipped: 0, entries: [] };
    }

    // Parse based on source type
    let proposed: CreateKnowledgeInput[];
    switch (source.type) {
      case 'claude-md':
        proposed = parseClaudeMd(content, source.path);
        break;
      case 'readme':
        proposed = parseReadme(content, source.path);
        break;
      case 'cursorrules':
        proposed = parseCursorRules(content, source.path);
        break;
      case 'adr':
        proposed = parseAdr(content, source.path);
        break;
      default:
        proposed = parseGenericMd(content, source.path);
    }

    // Deduplicate against existing entries
    let imported = 0;
    let skipped = 0;
    const entries: { title: string; type: string }[] = [];

    for (const input of proposed) {
      // Check if title already exists
      const existing = this.repo.getByTitle(input.title);
      if (existing) {
        skipped++;
        continue;
      }

      const entry = this.repo.insert(input);

      // Generate embedding
      if (this.embeddings.isAvailable()) {
        const vec = await this.embeddings.embed(`${entry.title} ${entry.content}`);
        if (vec) {
          this.search.storeEmbedding(entry.id, vec, this.embeddings.modelName());
        }
      }

      imported++;
      entries.push({ title: entry.title, type: entry.type });
    }

    return { source: source.name, imported, skipped, entries };
  }
}

function guessFileType(filePath: string): ImportSource['type'] {
  const lower = filePath.toLowerCase();
  if (lower.includes('claude.md') || lower.includes('claude_md')) return 'claude-md';
  if (lower.includes('readme')) return 'readme';
  if (lower.includes('cursorrules') || lower.includes('cursor/rules')) return 'cursorrules';
  if (lower.includes('adr') || lower.includes('decision')) return 'adr';
  return 'generic-md';
}
