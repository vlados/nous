#!/usr/bin/env node

import { Command } from 'commander';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { init } from '../src/cli/init.js';
import { startMcpServer } from '../src/mcp/server.js';
import { startVizServer } from '../src/viz/server.js';
import { findNousDir, loadConfig } from '../src/utils/config.js';
import { getConnection, closeConnection } from '../src/db/connection.js';
import { KnowledgeRepository } from '../src/knowledge/repository.js';
import { RelationshipRepository } from '../src/knowledge/relationships.js';
import type { KnowledgeType, KnowledgeStatus } from '../src/knowledge/types.js';

function requireNous(): { nousDir: string; db: ReturnType<typeof getConnection>; repo: KnowledgeRepository } {
  const nousDir = findNousDir();
  if (!nousDir) {
    console.error('No .nous/ directory found. Run `nous init` first.');
    process.exit(1);
  }
  const db = getConnection(join(nousDir, 'knowledge.db'));
  const repo = new KnowledgeRepository(db);
  return { nousDir, db, repo };
}

async function runImport(openaiKeyOverride?: string | null, anthropicKeyOverride?: string | null): Promise<void> {
  const { KnowledgeImporter } = await import('../src/import/importer.js');
  const { OpenAIEmbeddingEngine } = await import('../src/embeddings/api.js');
  const { FallbackEmbeddingEngine } = await import('../src/embeddings/fallback.js');

  const nousDir = findNousDir();
  if (!nousDir) return;

  const config = loadConfig(nousDir);
  const db = getConnection(join(nousDir, 'knowledge.db'));
  const openaiKey = openaiKeyOverride ?? config.openai_api_key ?? process.env['OPENAI_API_KEY'];
  const embeddings = openaiKey ? new OpenAIEmbeddingEngine(openaiKey) : new FallbackEmbeddingEngine();
  const importer = new KnowledgeImporter(db, embeddings);

  console.log('\n  Importing existing knowledge...');
  const results = await importer.importAll(process.cwd());

  let totalImported = 0;
  for (const r of results) {
    if (r.imported > 0) {
      console.log(`    ${r.source}: ${r.imported} entries`);
      totalImported += r.imported;
    }
  }

  if (totalImported === 0) {
    console.log('    No importable files found.');
  } else {
    console.log(`\n  Imported ${totalImported} entries.`);
  }

  closeConnection();
}

const program = new Command();

program
  .name('nous')
  .description('Per-project knowledge brain with auto-learning from AI conversations')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize nous in the current project')
  .option('-n, --name <name>', 'Project name (defaults to directory name)')
  .option('--hook', 'Install Claude Code hook for auto-learning')
  .option('--import', 'Auto-import knowledge from CLAUDE.md, README, .cursorrules, ADRs')
  .option('--scan', 'Scan codebase to learn project structure')
  .option('-y, --yes', 'Skip interactive prompts, use defaults')
  .action(async (options) => {
    const hasFlags = options.name || options.hook || options.import || options.scan || options.yes;

    // Interactive onboarding if no flags passed
    if (!hasFlags && process.stdin.isTTY) {
      const { runOnboarding } = await import('../src/cli/onboarding.js');
      const { saveConfig, loadConfig: loadCfg } = await import('../src/utils/config.js');
      const answers = await runOnboarding();

      // Run init with answers
      const result = init({ name: answers.projectName, hook: answers.installHook });
      console.log(result);

      // Save API keys to config
      const nd = findNousDir();
      if (nd && (answers.openaiKey || answers.anthropicKey)) {
        const cfg = loadCfg(nd);
        if (answers.openaiKey) cfg.openai_api_key = answers.openaiKey;
        if (answers.anthropicKey) cfg.anthropic_api_key = answers.anthropicKey;
        saveConfig(nd, cfg);
        console.log('  API keys saved to .nous/config.json');
      }

      // Scan codebase
      if (answers.runScan) {
        const { ProjectScanner } = await import('../src/scan/scanner.js');
        const { OpenAIEmbeddingEngine } = await import('../src/embeddings/api.js');
        const { FallbackEmbeddingEngine } = await import('../src/embeddings/fallback.js');

        const scanNousDir = findNousDir()!;
        const scanDb = getConnection(join(scanNousDir, 'knowledge.db'));
        const openaiKey = answers.openaiKey ?? process.env['OPENAI_API_KEY'];
        const embeddings = openaiKey ? new OpenAIEmbeddingEngine(openaiKey) : new FallbackEmbeddingEngine();
        const scanner = new ProjectScanner(scanDb, embeddings, answers.anthropicKey ?? undefined);

        const scanResult = await scanner.scan(process.cwd(), {
          onProgress: (msg) => console.log(`  ${msg}`),
        });

        console.log(`  Brain: ${scanResult.entriesCreated} entries from codebase scan`);
        closeConnection();
      }

      // Import docs
      if (answers.importFiles) {
        await runImport(answers.openaiKey, answers.anthropicKey);
      }

      console.log('\n  Done. Start Claude Code in this project — nous is ready.\n');
      return;
    }

    // Non-interactive mode (flags or piped stdin)
    const result = init(options);
    console.log(result);

    if (options.scan) {
      const { ProjectScanner } = await import('../src/scan/scanner.js');
      const { OpenAIEmbeddingEngine } = await import('../src/embeddings/api.js');
      const { FallbackEmbeddingEngine } = await import('../src/embeddings/fallback.js');

      const nd = findNousDir()!;
      const cfg = loadConfig(nd);
      const scanDb = getConnection(join(nd, 'knowledge.db'));
      const oKey = cfg.openai_api_key ?? process.env['OPENAI_API_KEY'];
      const aKey = cfg.anthropic_api_key ?? process.env['ANTHROPIC_API_KEY'];
      const emb = oKey ? new OpenAIEmbeddingEngine(oKey) : new FallbackEmbeddingEngine();
      const scanner = new ProjectScanner(scanDb, emb, aKey ?? undefined);

      const scanResult = await scanner.scan(process.cwd(), {
        onProgress: (msg) => console.log(`  ${msg}`),
      });
      console.log(`  Brain: ${scanResult.entriesCreated} entries from scan`);
      closeConnection();
    }

    if (options.import) {
      await runImport();
    }
  });

program
  .command('scan')
  .description('Analyze the codebase and populate the brain with project knowledge')
  .option('--no-ai', 'Skip AI analysis, only use static detection')
  .action(async (options: { ai: boolean }) => {
    const { ProjectScanner } = await import('../src/scan/scanner.js');
    const { OpenAIEmbeddingEngine } = await import('../src/embeddings/api.js');
    const { FallbackEmbeddingEngine } = await import('../src/embeddings/fallback.js');

    const { nousDir, db } = requireNous();
    const config = loadConfig(nousDir);

    const openaiKey = config.openai_api_key ?? process.env['OPENAI_API_KEY'];
    const anthropicKey = config.anthropic_api_key ?? process.env['ANTHROPIC_API_KEY'];
    const embeddings = openaiKey ? new OpenAIEmbeddingEngine(openaiKey) : new FallbackEmbeddingEngine();

    const scanner = new ProjectScanner(db, embeddings, anthropicKey ?? undefined);

    console.log('');
    const result = await scanner.scan(process.cwd(), {
      onProgress: (msg) => console.log(`  ${msg}`),
      skipAi: !options.ai,
    });

    const { scan } = result;

    // Print results
    console.log('');
    console.log('  ─────────────────────────────────────────');

    if (scan.stack.languages.length) {
      console.log(`  Languages:    ${scan.stack.languages.join(', ')}`);
    }
    if (scan.stack.framework) {
      console.log(`  Framework:    ${scan.stack.framework} ${scan.stack.frameworkVersion ?? ''}`);
    }
    if (scan.stack.database.length) {
      console.log(`  Database:     ${scan.stack.database.join(', ')}`);
    }
    console.log(`  Architecture: ${scan.architecture.pattern}`);

    if (scan.entryPoints.length) {
      console.log(`  Entry points: ${scan.entryPoints.map((e) => e.path).join(', ')}`);
    }
    if (scan.models.length) {
      console.log(`  Models:       ${scan.models.length} (${scan.models.slice(0, 5).map((m) => m.name).join(', ')}${scan.models.length > 5 ? '...' : ''})`);
    }
    if (scan.routes.length) {
      const total = scan.routes.reduce((sum, r) => sum + r.count, 0);
      console.log(`  Routes:       ${total} across ${scan.routes.length} files`);
    }
    if (scan.migrations.length) {
      console.log(`  Migrations:   ${scan.migrations.length}`);
    }
    if (scan.tests.fileCount > 0) {
      console.log(`  Tests:        ${scan.tests.fileCount} files (${scan.tests.framework ?? 'unknown'})`);
    }
    if (scan.cicd.length) {
      console.log(`  CI/CD:        ${scan.cicd.map((c) => c.name).join(', ')}`);
    }

    console.log('');
    console.log(`  Brain: ${result.entriesCreated} entries created, ${result.relationshipsCreated} relationships`);
    console.log(`  Run \`npx nousdb viz\` to explore the brain.`);
    console.log('');

    closeConnection();
  });

program
  .command('import [file]')
  .description('Import knowledge from project files. Without args: auto-detect CLAUDE.md, README, .cursorrules, ADRs. With file: import specific file.')
  .option('-t, --type <type>', 'File type hint: claude-md, readme, cursorrules, adr, generic-md')
  .action(async (file?: string, options?: { type?: string }) => {
    const { KnowledgeImporter } = await import('../src/import/importer.js');
    const { detectSources } = await import('../src/import/sources.js');
    const { OpenAIEmbeddingEngine } = await import('../src/embeddings/api.js');
    const { FallbackEmbeddingEngine } = await import('../src/embeddings/fallback.js');

    const { nousDir, db } = requireNous();
    const config = loadConfig(nousDir);
    const apiKey = config.openai_api_key ?? process.env['OPENAI_API_KEY'];
    const embeddings = apiKey ? new OpenAIEmbeddingEngine(apiKey) : new FallbackEmbeddingEngine();
    const importer = new KnowledgeImporter(db, embeddings);

    if (file) {
      // Import specific file
      const result = await importer.importFile(file, options?.type as any);
      if (result.imported > 0) {
        console.log(`Imported ${result.imported} entries from ${file}:`);
        for (const e of result.entries) {
          console.log(`  [${e.type}] ${e.title}`);
        }
      } else {
        console.log(`No new knowledge extracted from ${file}. (${result.skipped} duplicates skipped)`);
      }
    } else {
      // Auto-detect and import all
      const sources = detectSources(process.cwd());
      if (sources.length === 0) {
        console.log('No importable files found (CLAUDE.md, README.md, .cursorrules, docs/adr/)');
        closeConnection();
        return;
      }

      console.log(`Found ${sources.length} sources:`);
      for (const s of sources) {
        console.log(`  ${s.name} (${s.path})`);
      }
      console.log('');

      const results = await importer.importAll(process.cwd());
      let total = 0;
      for (const r of results) {
        if (r.imported > 0) {
          console.log(`${r.source}: ${r.imported} entries`);
          for (const e of r.entries) {
            console.log(`  [${e.type}] ${e.title}`);
          }
          total += r.imported;
        } else if (r.skipped > 0) {
          console.log(`${r.source}: ${r.skipped} already imported`);
        }
      }

      console.log(`\nTotal: ${total} new entries imported.`);
    }

    closeConnection();
  });

program
  .command('serve')
  .description('Start the MCP server (stdio transport)')
  .action(async () => {
    await startMcpServer();
  });

program
  .command('viz')
  .description('Open the brain visualization in your browser')
  .option('-p, --port <port>', 'Port number', '4200')
  .option('--no-open', 'Do not open browser automatically')
  .action(async (options: { port: string; open: boolean }) => {
    const port = parseInt(options.port, 10);
    const { url } = startVizServer(port);
    console.log(`\nnous brain visualization: ${url}\n`);

    if (options.open) {
      const { exec } = await import('node:child_process');
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${cmd} ${url}`);
    }

    console.log('Press Ctrl+C to stop.\n');
  });

program
  .command('status')
  .description('Show brain statistics')
  .action(() => {
    const { nousDir, db, repo } = requireNous();
    const config = loadConfig(nousDir);
    const stats = repo.status();

    const hasAnthropic = !!(config.anthropic_api_key ?? process.env['ANTHROPIC_API_KEY']);
    const hasOpenai = !!(config.openai_api_key ?? process.env['OPENAI_API_KEY']);

    console.log(`\nnous brain: ${config.project_name}`);
    console.log('─────────────────────────────');
    console.log(`Entries:       ${stats.total_entries}`);
    console.log(`  Concepts:    ${stats.by_type.concept}`);
    console.log(`  Decisions:   ${stats.by_type.decision}`);
    console.log(`  Patterns:    ${stats.by_type.pattern}`);
    console.log(`Relationships: ${stats.total_relationships}`);
    console.log(`Embeddings:    ${stats.total_embeddings} (${Math.round(stats.embedding_coverage * 100)}% coverage)`);
    console.log(`Extraction:    ${hasAnthropic ? 'AI (Claude Haiku)' : 'heuristic (regex)'}`);
    console.log(`Search:        ${hasOpenai ? 'hybrid (keyword + semantic)' : 'keyword only'}`);
    console.log(`Last activity: ${stats.last_activity ?? 'none'}`);

    closeConnection();
  });

program
  .command('teach <type> <title> <content>')
  .description('Teach nous something new (type: concept, decision, pattern)')
  .option('-t, --tags <tags>', 'Comma-separated tags')
  .option('-s, --scope <scope>', 'Scope (backend, frontend, infra, api)')
  .action((type: string, title: string, content: string, options: { tags?: string; scope?: string }) => {
    if (!['concept', 'decision', 'pattern'].includes(type)) {
      console.error('Type must be: concept, decision, or pattern');
      process.exit(1);
    }

    const { repo } = requireNous();

    const entry = repo.insert({
      type: type as KnowledgeType,
      title,
      content,
      tags: options.tags ? options.tags.split(',').map((t) => t.trim()) : [],
      scope: options.scope ?? '',
    });

    console.log(`Learned ${entry.type}: "${entry.title}" (${entry.id})`);
    closeConnection();
  });

program
  .command('ask <question>')
  .description('Search the brain')
  .option('-t, --type <type>', 'Filter by type (concept, decision, pattern)')
  .option('-l, --limit <limit>', 'Max results', '5')
  .action((question: string, options: { type?: string; limit: string }) => {
    const { db } = requireNous();
    const limit = parseInt(options.limit, 10);

    // Phase 1: FTS5 only. Phase 2 will add hybrid vector+FTS search.
    const conditions = ["knowledge_fts MATCH ?", "k.status = 'active'"];
    const params: unknown[] = [question];

    if (options.type) {
      conditions.push('k.type = ?');
      params.push(options.type);
    }
    params.push(limit);

    try {
      const rows = db
        .prepare(
          `SELECT k.*, rank
           FROM knowledge_fts fts
           JOIN knowledge k ON k.rowid = fts.rowid
           WHERE ${conditions.join(' AND ')}
           ORDER BY rank
           LIMIT ?`,
        )
        .all(...params) as Record<string, unknown>[];

      if (rows.length === 0) {
        console.log('No results found.');
      } else {
        for (const row of rows) {
          console.log(`\n[${row.type}] ${row.title}`);
          console.log(`  ${(row.content as string).slice(0, 200)}`);
          console.log(`  id: ${row.id}  confidence: ${row.confidence}`);
        }
      }
    } catch {
      console.log('No results found.');
    }

    closeConnection();
  });

program
  .command('export')
  .description('Export brain contents')
  .option('-f, --format <format>', 'Output format: json or markdown', 'markdown')
  .option('-o, --output <path>', 'Output file path (defaults to stdout)')
  .action((options: { format: string; output?: string }) => {
    const { db, repo } = requireNous();
    const relRepo = new RelationshipRepository(db);

    const entries = repo.list({ status: 'active' as KnowledgeStatus, limit: 10000 });
    const graph = relRepo.graph();

    let output: string;

    if (options.format === 'json') {
      output = JSON.stringify({ entries, relationships: graph.edges }, null, 2);
    } else {
      // Markdown format
      const sections: string[] = ['# Project Knowledge Brain\n'];

      const concepts = entries.filter((e) => e.type === 'concept');
      const decisions = entries.filter((e) => e.type === 'decision');
      const patterns = entries.filter((e) => e.type === 'pattern');

      if (concepts.length > 0) {
        sections.push('## Concepts\n');
        for (const c of concepts) {
          sections.push(`### ${c.title}\n`);
          sections.push(c.content + '\n');
          if (c.tags.length > 0) sections.push(`*Tags: ${c.tags.join(', ')}*\n`);
          sections.push('');
        }
      }

      if (decisions.length > 0) {
        sections.push('## Decisions\n');
        for (const d of decisions) {
          sections.push(`### ${d.title}\n`);
          sections.push(d.content + '\n');
          if (d.tags.length > 0) sections.push(`*Tags: ${d.tags.join(', ')}*\n`);
          sections.push('');
        }
      }

      if (patterns.length > 0) {
        sections.push('## Patterns\n');
        for (const p of patterns) {
          sections.push(`### ${p.title}\n`);
          sections.push(p.content + '\n');
          if (p.tags.length > 0) sections.push(`*Tags: ${p.tags.join(', ')}*\n`);
          sections.push('');
        }
      }

      output = sections.join('\n');
    }

    if (options.output) {
      writeFileSync(options.output, output);
      console.log(`Exported to ${options.output}`);
    } else {
      process.stdout.write(output);
    }

    closeConnection();
  });

program
  .command('extract')
  .description('Extract knowledge from text (reads from stdin)')
  .option('--stdin', 'Read text from stdin')
  .option('--auto-save', 'Automatically save extracted knowledge')
  .option('--source <source>', 'Source identifier', 'cli')
  .action(async (options: { stdin?: boolean; autoSave?: boolean; source: string }) => {
    const { KnowledgeExtractor } = await import('../src/extraction/extractor.js');
    const { OpenAIEmbeddingEngine } = await import('../src/embeddings/api.js');
    const { FallbackEmbeddingEngine } = await import('../src/embeddings/fallback.js');

    const { nousDir, db } = requireNous();
    const config = loadConfig(nousDir);

    const openaiKey = config.openai_api_key ?? process.env['OPENAI_API_KEY'];
    const anthropicKey = config.anthropic_api_key ?? process.env['ANTHROPIC_API_KEY'];
    const embeddings = openaiKey ? new OpenAIEmbeddingEngine(openaiKey) : new FallbackEmbeddingEngine();
    const extractor = new KnowledgeExtractor(db, embeddings, anthropicKey ?? undefined);

    let text = '';
    if (options.stdin) {
      // Read from stdin
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      text = Buffer.concat(chunks).toString('utf-8');
    } else {
      console.error('Use --stdin to pipe text, e.g.: echo "some text" | nous extract --stdin');
      process.exit(1);
    }

    if (!text.trim()) {
      console.log('No text to extract from.');
      closeConnection();
      return;
    }

    const result = await extractor.extract(text, {
      source: 'extracted' as const,
      sourceRef: `cli-${Date.now()}`,
      autoSave: options.autoSave ?? false,
    });

    if (result.saved.length > 0) {
      console.log(`Saved ${result.saved.length} entries (via ${result.method}):`);
      for (const entry of result.saved) {
        console.log(`  [${entry.type}] ${entry.title} (${entry.id})`);
      }
    }

    if (result.proposed.length > 0) {
      console.log(`Proposed ${result.proposed.length} entries:`);
      for (const p of result.proposed) {
        console.log(`  [${p.type}] ${p.title} (confidence: ${p.confidence.toFixed(2)})`);
      }
      console.log('\nRun with --auto-save to save automatically.');
    }

    if (result.skipped.length > 0) {
      console.log(`Skipped ${result.skipped.length}:`);
      for (const s of result.skipped) {
        console.log(`  ${s.title}: ${s.reason}`);
      }
    }

    if (result.saved.length === 0 && result.proposed.length === 0 && result.skipped.length === 0) {
      console.log('No knowledge extracted.');
    }

    closeConnection();
  });

program.parse();
