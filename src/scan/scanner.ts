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

    // Models overview — read each model file for relationships and traits
    if (models.length > 0) {
      const modelDetails = models.map((m) => {
        try {
          const content = readFileSync(join(projectDir, m.path), 'utf-8');
          const relations = this.extractModelRelations(content);
          const traits = this.extractTraits(content);
          const parts = [m.name];
          if (relations.length) parts.push(`(${relations.join(', ')})`);
          if (traits.length) parts.push(`[${traits.join(', ')}]`);
          return parts.join(' ');
        } catch { return m.name; }
      });

      this.createEntry({
        type: 'concept',
        title: 'Data Models',
        content: `${models.length} models:\n${modelDetails.map((d) => `- ${d}`).join('\n')}`,
        tags: ['models', 'database'],
        scope: 'backend',
      });
      entriesCreated++;
    }

    // Routes overview — parse actual route definitions
    if (routes.length > 0) {
      const routeDetails: string[] = [];
      for (const route of routes) {
        try {
          const content = readFileSync(join(projectDir, route.file), 'utf-8');
          const parsed = this.parseRouteFile(content, stack);
          routeDetails.push(`${route.file} (${route.type}):\n${parsed.map((r) => `  ${r.method} ${r.path} → ${r.handler}`).join('\n')}`);
        } catch {
          routeDetails.push(`${route.file}: ${route.count} ${route.type} routes`);
        }
      }

      this.createEntry({
        type: 'concept',
        title: 'Routes & Endpoints',
        content: routeDetails.join('\n\n'),
        tags: ['routes', 'navigation'],
        scope: routes.some((r) => r.type === 'api') ? 'api' : 'backend',
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

    // CI/CD
    if (cicd.length > 0) {
      this.createEntry({
        type: 'concept',
        title: 'Build & Deploy',
        content: cicd.map((f) => `- ${f.path}`).join('\n'),
        tags: ['cicd', 'devops'],
        scope: 'infra',
      });
      entriesCreated++;
    }

    // Config overview
    if (config.envVars.length > 0) {
      const grouped = this.groupEnvVars(config.envVars);
      this.createEntry({
        type: 'concept',
        title: 'Configuration & Environment',
        content: Object.entries(grouped)
          .map(([group, vars]) => `${group}: ${vars.join(', ')}`)
          .join('\n'),
        tags: ['config', 'environment'],
        scope: 'infra',
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

  /** Extract relationship method names from a PHP/TS model file. */
  private extractModelRelations(content: string): string[] {
    const relations: string[] = [];
    // PHP Eloquent
    const phpMatches = content.matchAll(/function\s+(\w+)\(\).*(?:hasMany|hasOne|belongsTo|belongsToMany|morphTo|morphMany|morphOne)\b/g);
    for (const m of phpMatches) relations.push(m[1]!);
    // Also match return type hints
    const phpReturnMatches = content.matchAll(/(hasMany|hasOne|belongsTo|belongsToMany)\(\s*(\w+)::class/g);
    for (const m of phpReturnMatches) {
      const rel = `${m[1]}:${m[2]}`;
      if (!relations.includes(rel)) relations.push(rel);
    }
    return [...new Set(relations)].slice(0, 5);
  }

  /** Extract trait/concern names from a PHP/TS file. */
  private extractTraits(content: string): string[] {
    const traits: string[] = [];
    const phpMatches = content.matchAll(/use\s+(\w+(?:Trait|Concern|able))/g);
    for (const m of phpMatches) traits.push(m[1]!);
    // Common Laravel traits
    const commonTraits = ['SoftDeletes', 'HasFactory', 'Notifiable', 'HasApiTokens', 'HasUuids', 'HasUlids'];
    for (const t of commonTraits) {
      if (content.includes(t) && !traits.includes(t)) traits.push(t);
    }
    return traits.filter((t) => t !== 'HasFactory'); // HasFactory is noise
  }

  /** Parse Laravel/Express route files into structured routes. */
  private parseRouteFile(content: string, stack: StackInfo): { method: string; path: string; handler: string }[] {
    const routes: { method: string; path: string; handler: string }[] = [];

    if (stack.framework === 'Laravel') {
      // Route::get('/path', Handler::class)
      const matches = content.matchAll(/Route::(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]\s*,\s*(\S+?)[\s)]/gi);
      for (const m of matches) {
        routes.push({
          method: m[1]!.toUpperCase(),
          path: m[2]!,
          handler: m[3]!.replace('::class', '').replace(/\\/g, '').split(',')[0]!,
        });
      }
      // Route::view
      const viewMatches = content.matchAll(/Route::view\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/gi);
      for (const m of viewMatches) {
        routes.push({ method: 'GET', path: m[1]!, handler: `view:${m[2]}` });
      }
    } else {
      // Express-style: app.get('/path', handler)
      const matches = content.matchAll(/\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/gi);
      for (const m of matches) {
        routes.push({ method: m[1]!.toUpperCase(), path: m[2]!, handler: '' });
      }
    }

    return routes.slice(0, 30);
  }

  /** Group env vars by prefix for readable output. */
  private groupEnvVars(vars: string[]): Record<string, string[]> {
    const groups: Record<string, string[]> = {};
    for (const v of vars) {
      const prefix = v.split('_').slice(0, 1).join('_');
      const group = ['APP', 'DB', 'MAIL', 'REDIS', 'CACHE', 'QUEUE', 'LOG', 'AWS', 'VITE', 'REVERB', 'STRIPE'].includes(prefix)
        ? prefix
        : 'Other';
      if (!groups[group]) groups[group] = [];
      groups[group]!.push(v);
    }
    return groups;
  }
}
