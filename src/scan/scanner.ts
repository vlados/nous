import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import type { EmbeddingEngine } from '../embeddings/engine.js';
import { KnowledgeRepository } from '../knowledge/repository.js';
import { KnowledgeSearch } from '../knowledge/search.js';
import { RelationshipRepository } from '../knowledge/relationships.js';
import type { KnowledgeType, CreateKnowledgeInput } from '../knowledge/types.js';
import {
  detectStack,
  detectArchitecture,
  findEntryPoints,
  findModels,
  findRoutes,
  findMigrations,
  detectTests,
  detectConfig,
  detectCiCd,
  findKeyFiles,
  type ProjectScan,
  type FileInfo,
  type StackInfo,
  type ArchitectureInfo,
} from './detector.js';

export interface ScanResult {
  scan: ProjectScan;
  entriesCreated: number;
  relationshipsCreated: number;
}

const SUMMARIZE_PROMPT = `You are analyzing source code files for a project knowledge brain called "nous".

For each file, extract valuable knowledge entries. Return a JSON array of entries:

[{
  "type": "concept" | "decision" | "pattern",
  "title": "short title (max 60 chars)",
  "content": "clear standalone description — someone reading this should understand without seeing the code",
  "tags": ["tag1", "tag2"],
  "scope": "backend" | "frontend" | "infra" | "api" | "",
  "relationships": [{"target_title": "...", "relation": "depends_on|implements|related_to|requires"}]
}]

Rules:
- concept: how something works, what a component does
- decision: why something was chosen (look for comments explaining "why")
- pattern: conventions, rules, recurring approaches
- Write content in plain language, not code descriptions
- Don't extract trivial things (imports, boilerplate)
- Max 5 entries per file — only the most important
- Relationships link to OTHER entries by title (they may not exist yet, that's ok)
- Return empty array [] if nothing worth extracting

Respond with ONLY the JSON array.`;

export class ProjectScanner {
  private repo: KnowledgeRepository;
  private search: KnowledgeSearch;
  private relationships: RelationshipRepository;
  private anthropic: Anthropic | null = null;

  constructor(
    private db: Database.Database,
    private embeddings: EmbeddingEngine,
    anthropicKey?: string,
  ) {
    this.repo = new KnowledgeRepository(db);
    this.search = new KnowledgeSearch(db, embeddings);
    this.relationships = new RelationshipRepository(db);

    const key = anthropicKey ?? process.env['ANTHROPIC_API_KEY'];
    if (key) {
      this.anthropic = new Anthropic({ apiKey: key });
    }
  }

  /**
   * Run a full project scan.
   * Layer 1: Static detection (instant)
   * Layer 2: AI summarization of key files (if Anthropic key available)
   * Layer 3: Relationship mapping
   */
  async scan(
    projectDir: string,
    options: {
      onProgress?: (message: string) => void;
      skipAi?: boolean;
    } = {},
  ): Promise<ScanResult> {
    const log = options.onProgress ?? (() => {});

    // ── Layer 1: Static Detection ────────────
    log('Detecting tech stack...');
    const stack = detectStack(projectDir);

    log('Analyzing architecture...');
    const architecture = detectArchitecture(projectDir);

    log('Finding entry points...');
    const entryPoints = findEntryPoints(projectDir, stack);

    log('Finding models...');
    const models = findModels(projectDir, stack);

    log('Finding routes...');
    const routes = findRoutes(projectDir, stack);

    log('Finding migrations...');
    const migrations = findMigrations(projectDir);

    log('Detecting tests...');
    const tests = detectTests(projectDir, stack);

    log('Detecting config...');
    const config = detectConfig(projectDir);

    log('Detecting CI/CD...');
    const cicd = detectCiCd(projectDir);

    log('Finding key files...');
    const keyFiles = findKeyFiles(projectDir, stack);

    const scan: ProjectScan = {
      name: '',
      stack,
      architecture,
      entryPoints,
      models,
      routes,
      migrations,
      tests,
      config,
      cicd,
      keyFiles,
    };

    // ── Store Layer 1 results as knowledge ───
    let entriesCreated = 0;

    // Tech stack concept
    const stackDesc = this.formatStackDescription(stack);
    if (stackDesc) {
      this.createEntry({
        type: 'concept',
        title: 'Tech Stack',
        content: stackDesc,
        tags: ['stack', 'infrastructure'],
        scope: '',
      });
      entriesCreated++;
    }

    // Architecture concept
    const archDesc = this.formatArchitectureDescription(architecture, stack);
    if (archDesc) {
      this.createEntry({
        type: 'concept',
        title: 'Project Architecture',
        content: archDesc,
        tags: ['architecture', 'structure'],
        scope: '',
      });
      entriesCreated++;
    }

    // Models overview
    if (models.length > 0) {
      this.createEntry({
        type: 'concept',
        title: 'Data Models',
        content: `${models.length} models: ${models.map((m) => m.name).join(', ')}`,
        tags: ['models', 'database'],
        scope: 'backend',
      });
      entriesCreated++;
    }

    // Routes overview
    if (routes.length > 0) {
      const totalRoutes = routes.reduce((sum, r) => sum + r.count, 0);
      this.createEntry({
        type: 'concept',
        title: 'API Routes',
        content: routes.map((r) => `${r.file}: ${r.count} ${r.type} routes`).join('\n'),
        tags: ['routes', 'api'],
        scope: 'api',
      });
      entriesCreated++;
    }

    // Testing setup
    if (tests.framework || tests.fileCount > 0) {
      this.createEntry({
        type: 'pattern',
        title: 'Testing Setup',
        content: `Tests use ${tests.framework ?? 'unknown framework'} in ${tests.directory ?? 'unknown dir'}. ${tests.fileCount} test files found.`,
        tags: ['tests', 'quality'],
        scope: '',
      });
      entriesCreated++;
    }

    // ── Layer 2: AI Summarization ────────────
    let relationshipsCreated = 0;

    if (this.anthropic && !options.skipAi) {
      log('Analyzing key files with Claude...');

      // Pick the most important files to analyze (cap at 15)
      const filesToAnalyze = this.prioritizeFiles(keyFiles, projectDir);

      for (const file of filesToAnalyze) {
        log(`  ${file.path}...`);
        try {
          const content = readFileSync(join(projectDir, file.path), 'utf-8');
          // Skip very large files
          if (content.length > 15000) continue;

          const entries = await this.summarizeFile(file.path, content);

          for (const entry of entries) {
            const existing = this.repo.getByTitle(entry.title);
            if (existing) continue; // Skip duplicates

            const created = this.createEntry({
              type: entry.type,
              title: entry.title,
              content: entry.content,
              tags: entry.tags ?? [],
              scope: entry.scope ?? '',
            });
            entriesCreated++;

            // Create relationships
            if (entry.relationships) {
              for (const rel of entry.relationships) {
                const target = this.repo.getByTitle(rel.target_title);
                if (target && created) {
                  try {
                    this.relationships.create({
                      from_id: created.id,
                      to_id: target.id,
                      relation_type: rel.relation as any,
                    });
                    relationshipsCreated++;
                  } catch {} // Ignore duplicate relationships
                }
              }
            }
          }
        } catch (err) {
          // Skip files that can't be read or analyzed
        }
      }
    } else if (!this.anthropic) {
      log('No Anthropic API key — skipping AI analysis. Run `npx nousdb init` to configure.');
    }

    return { scan, entriesCreated, relationshipsCreated };
  }

  private createEntry(input: Omit<CreateKnowledgeInput, 'source' | 'source_ref' | 'confidence'>): ReturnType<KnowledgeRepository['insert']> | null {
    // Check for duplicate
    const existing = this.repo.getByTitle(input.title);
    if (existing) return null;

    const entry = this.repo.insert({
      ...input,
      source: 'imported',
      source_ref: 'scan',
      confidence: 0.85,
    });

    // Generate embedding async (don't await to keep scan fast)
    if (this.embeddings.isAvailable()) {
      this.embeddings.embed(`${entry.title} ${entry.content}`).then((vec) => {
        if (vec) this.search.storeEmbedding(entry.id, vec, this.embeddings.modelName());
      }).catch(() => {});
    }

    return entry;
  }

  private async summarizeFile(
    filePath: string,
    content: string,
  ): Promise<Array<{
    type: KnowledgeType;
    title: string;
    content: string;
    tags?: string[];
    scope?: string;
    relationships?: Array<{ target_title: string; relation: string }>;
  }>> {
    if (!this.anthropic) return [];

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: `${SUMMARIZE_PROMPT}\n\n--- File: ${filePath} ---\n\n${content.slice(0, 10000)}`,
          },
        ],
      });

      const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
      const cleaned = text.trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();

      try {
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        const match = cleaned.match(/\[[\s\S]*\]/);
        if (match) {
          try {
            return JSON.parse(match[0]);
          } catch {}
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('already logged')) {
        console.warn(`[nous] AI analysis failed for ${filePath}: ${msg}`);
      }
    }

    return [];
  }

  private prioritizeFiles(files: FileInfo[], projectDir: string): FileInfo[] {
    // Score files by importance
    const scored = files.map((f) => {
      let score = 0;

      // Route files are very important
      if (/route/i.test(f.path)) score += 10;
      // Service files explain business logic
      if (/service/i.test(f.path)) score += 8;
      // Controllers show the API surface
      if (/controller/i.test(f.path)) score += 7;
      // Config files explain decisions
      if (/config/i.test(f.path)) score += 6;
      // Models define data
      if (/model/i.test(f.path)) score += 5;
      // Middleware shows cross-cutting concerns
      if (/middleware/i.test(f.path)) score += 5;
      // Provider/bootstrap shows wiring
      if (/provider|bootstrap/i.test(f.path)) score += 4;

      // Deprioritize generated/docs files
      if (/readme|changelog|license/i.test(f.name)) score -= 5;
      // Skip CLAUDE.md — imported separately
      if (f.name === 'CLAUDE.md') score -= 10;

      // Prefer smaller files (more focused)
      if (f.size < 3000) score += 2;
      else if (f.size > 10000) score -= 2;

      return { file: f, score };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .filter((s) => s.score > 0)
      .slice(0, 15)
      .map((s) => s.file);
  }

  private formatStackDescription(stack: StackInfo): string {
    const parts: string[] = [];

    if (stack.languages.length) parts.push(`Languages: ${stack.languages.join(', ')}`);
    if (stack.framework) parts.push(`Framework: ${stack.framework} ${stack.frameworkVersion ?? ''}`);
    if (stack.runtime) parts.push(`Runtime: ${stack.runtime}`);
    if (stack.database.length) parts.push(`Database: ${stack.database.join(', ')}`);
    if (stack.packageManager) parts.push(`Package manager: ${stack.packageManager}`);

    // Key dependencies
    const notable = Object.keys(stack.dependencies).filter((d) =>
      !d.startsWith('@types/') && !['typescript', 'ts-node', 'tsx'].includes(d),
    ).slice(0, 15);

    if (notable.length) parts.push(`Key dependencies: ${notable.join(', ')}`);

    return parts.join('\n');
  }

  private formatArchitectureDescription(arch: ArchitectureInfo, stack: StackInfo): string {
    const parts: string[] = [];

    parts.push(`Architecture pattern: ${arch.pattern}`);
    if (arch.topDirs.length) parts.push(`Top-level directories: ${arch.topDirs.join(', ')}`);
    if (arch.hasDocker) parts.push('Containerized with Docker');
    if (arch.hasMonorepo) parts.push('Monorepo structure');

    return parts.join('\n');
  }
}
