import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

// ── Types ────────────────────────────────────

export interface ProjectScan {
  name: string;
  stack: StackInfo;
  architecture: ArchitectureInfo;
  entryPoints: FileInfo[];
  models: FileInfo[];
  routes: RouteInfo[];
  migrations: FileInfo[];
  tests: TestInfo;
  config: ConfigInfo;
  cicd: FileInfo[];
  keyFiles: FileInfo[];
}

export interface StackInfo {
  languages: string[];
  framework: string | null;
  frameworkVersion: string | null;
  runtime: string | null;
  database: string[];
  packageManager: string | null;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

export interface ArchitectureInfo {
  pattern: string; // mvc, services, monorepo, flat, etc.
  topDirs: string[];
  hasDocker: boolean;
  hasMonorepo: boolean;
}

export interface FileInfo {
  path: string;
  name: string;
  size: number;
}

export interface RouteInfo {
  file: string;
  count: number;
  type: 'web' | 'api' | 'unknown';
}

export interface TestInfo {
  framework: string | null;
  directory: string | null;
  fileCount: number;
}

export interface ConfigInfo {
  envExample: boolean;
  configDir: string | null;
  envVars: string[];
}

// ── Stack Detection ──────────────────────────

export function detectStack(projectDir: string): StackInfo {
  const stack: StackInfo = {
    languages: [],
    framework: null,
    frameworkVersion: null,
    runtime: null,
    database: [],
    packageManager: null,
    dependencies: {},
    devDependencies: {},
  };

  // Node.js / JavaScript / TypeScript
  const packageJsonPath = join(projectDir, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      stack.runtime = 'node';
      stack.dependencies = pkg.dependencies ?? {};
      stack.devDependencies = pkg.devDependencies ?? {};

      if (existsSync(join(projectDir, 'tsconfig.json'))) stack.languages.push('TypeScript');
      else stack.languages.push('JavaScript');

      // Package manager detection
      if (existsSync(join(projectDir, 'pnpm-lock.yaml'))) stack.packageManager = 'pnpm';
      else if (existsSync(join(projectDir, 'yarn.lock'))) stack.packageManager = 'yarn';
      else if (existsSync(join(projectDir, 'bun.lockb'))) stack.packageManager = 'bun';
      else if (existsSync(join(projectDir, 'package-lock.json'))) stack.packageManager = 'npm';

      // Framework detection from deps
      const allDeps = { ...stack.dependencies, ...stack.devDependencies };
      if (allDeps['next']) { stack.framework = 'Next.js'; stack.frameworkVersion = allDeps['next']; }
      else if (allDeps['nuxt']) { stack.framework = 'Nuxt'; stack.frameworkVersion = allDeps['nuxt']; }
      else if (allDeps['@angular/core']) { stack.framework = 'Angular'; stack.frameworkVersion = allDeps['@angular/core']; }
      else if (allDeps['svelte'] || allDeps['@sveltejs/kit']) { stack.framework = 'Svelte'; stack.frameworkVersion = allDeps['svelte'] ?? allDeps['@sveltejs/kit'] ?? null; }
      else if (allDeps['vue']) { stack.framework = 'Vue'; stack.frameworkVersion = allDeps['vue']; }
      else if (allDeps['react']) { stack.framework = 'React'; stack.frameworkVersion = allDeps['react']; }
      else if (allDeps['express']) { stack.framework = 'Express'; stack.frameworkVersion = allDeps['express']; }
      else if (allDeps['fastify']) { stack.framework = 'Fastify'; stack.frameworkVersion = allDeps['fastify']; }
      else if (allDeps['hono']) { stack.framework = 'Hono'; stack.frameworkVersion = allDeps['hono']; }

      // Database from deps
      if (allDeps['prisma'] || allDeps['@prisma/client']) stack.database.push('Prisma');
      if (allDeps['pg'] || allDeps['postgres']) stack.database.push('PostgreSQL');
      if (allDeps['mysql2'] || allDeps['mysql']) stack.database.push('MySQL');
      if (allDeps['better-sqlite3'] || allDeps['sql.js']) stack.database.push('SQLite');
      if (allDeps['mongoose'] || allDeps['mongodb']) stack.database.push('MongoDB');
      if (allDeps['redis'] || allDeps['ioredis']) stack.database.push('Redis');
      if (allDeps['drizzle-orm']) stack.database.push('Drizzle');
      if (allDeps['typeorm']) stack.database.push('TypeORM');
      if (allDeps['sequelize']) stack.database.push('Sequelize');
    } catch {}
  }

  // PHP / Laravel
  const composerPath = join(projectDir, 'composer.json');
  if (existsSync(composerPath)) {
    try {
      const composer = JSON.parse(readFileSync(composerPath, 'utf-8'));
      stack.languages.push('PHP');
      stack.runtime = 'php';
      const require = composer.require ?? {};
      const requireDev = composer['require-dev'] ?? {};
      stack.dependencies = { ...stack.dependencies, ...require };
      stack.devDependencies = { ...stack.devDependencies, ...requireDev };

      if (require['laravel/framework']) {
        stack.framework = 'Laravel';
        stack.frameworkVersion = require['laravel/framework'];
      } else if (require['symfony/framework-bundle']) {
        stack.framework = 'Symfony';
        stack.frameworkVersion = require['symfony/framework-bundle'];
      }

      // Laravel-specific
      if (require['livewire/livewire']) stack.dependencies['livewire'] = require['livewire/livewire'];
      if (require['filament/filament']) stack.dependencies['filament'] = require['filament/filament'];

      // Database from PHP deps
      if (require['doctrine/dbal']) stack.database.push('Doctrine');
      if (existsSync(join(projectDir, 'database'))) {
        // Laravel database detection from .env or config
        const envPath = join(projectDir, '.env');
        if (existsSync(envPath)) {
          const env = readFileSync(envPath, 'utf-8');
          if (env.includes('DB_CONNECTION=pgsql')) stack.database.push('PostgreSQL');
          else if (env.includes('DB_CONNECTION=mysql')) stack.database.push('MySQL');
          else if (env.includes('DB_CONNECTION=sqlite')) stack.database.push('SQLite');
        }
      }
    } catch {}
  }

  // Python
  const pyprojectPath = join(projectDir, 'pyproject.toml');
  const requirementsPath = join(projectDir, 'requirements.txt');
  if (existsSync(pyprojectPath) || existsSync(requirementsPath)) {
    stack.languages.push('Python');
    stack.runtime = 'python';

    if (existsSync(requirementsPath)) {
      const reqs = readFileSync(requirementsPath, 'utf-8').toLowerCase();
      if (reqs.includes('django')) stack.framework = 'Django';
      else if (reqs.includes('flask')) stack.framework = 'Flask';
      else if (reqs.includes('fastapi')) stack.framework = 'FastAPI';
    }
  }

  // Go
  if (existsSync(join(projectDir, 'go.mod'))) {
    stack.languages.push('Go');
    stack.runtime = 'go';
  }

  // Rust
  if (existsSync(join(projectDir, 'Cargo.toml'))) {
    stack.languages.push('Rust');
    stack.runtime = 'rust';
  }

  // Ruby
  if (existsSync(join(projectDir, 'Gemfile'))) {
    stack.languages.push('Ruby');
    stack.runtime = 'ruby';
    const gemfile = readFileSync(join(projectDir, 'Gemfile'), 'utf-8').toLowerCase();
    if (gemfile.includes("'rails'") || gemfile.includes('"rails"')) stack.framework = 'Rails';
  }

  // Deduplicate databases
  stack.database = [...new Set(stack.database)];

  return stack;
}

// ── Architecture Detection ───────────────────

export function detectArchitecture(projectDir: string): ArchitectureInfo {
  const topDirs: string[] = [];

  try {
    const entries = readdirSync(projectDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'vendor') {
        topDirs.push(entry.name);
      }
    }
  } catch {}

  const hasDocker = existsSync(join(projectDir, 'Dockerfile')) || existsSync(join(projectDir, 'docker-compose.yml'));
  const hasMonorepo = existsSync(join(projectDir, 'packages')) || existsSync(join(projectDir, 'apps')) || existsSync(join(projectDir, 'services'));

  // Detect architecture pattern
  let pattern = 'flat';
  const dirSet = new Set(topDirs);

  if (hasMonorepo) pattern = 'monorepo';
  else if (dirSet.has('app') && dirSet.has('resources') && dirSet.has('routes')) pattern = 'laravel-mvc';
  else if (dirSet.has('src') && dirSet.has('pages') || dirSet.has('app') && existsSync(join(projectDir, 'next.config.js'))) pattern = 'nextjs';
  else if (dirSet.has('src') && dirSet.has('components')) pattern = 'component-based';
  else if (dirSet.has('models') || dirSet.has('views') || dirSet.has('controllers')) pattern = 'mvc';
  else if (dirSet.has('src')) pattern = 'src-based';
  else if (dirSet.has('cmd') && dirSet.has('internal') || dirSet.has('pkg')) pattern = 'go-standard';

  return { pattern, topDirs, hasDocker, hasMonorepo };
}

// ── Entry Points ─────────────────────────────

export function findEntryPoints(projectDir: string, stack: StackInfo): FileInfo[] {
  const candidates = [
    // Node.js
    'src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js',
    'src/app.ts', 'src/app.js', 'index.ts', 'index.js', 'server.ts', 'server.js',
    // Laravel
    'routes/web.php', 'routes/api.php', 'public/index.php',
    'bootstrap/app.php',
    // Python
    'main.py', 'app.py', 'manage.py', 'wsgi.py',
    // Go
    'main.go', 'cmd/main.go',
    // Ruby
    'config.ru', 'bin/rails',
  ];

  return candidates
    .map((p) => join(projectDir, p))
    .filter(existsSync)
    .map((p) => ({
      path: p.replace(projectDir + '/', ''),
      name: basename(p),
      size: statSync(p).size,
    }));
}

// ── Models ───────────────────────────────────

export function findModels(projectDir: string, stack: StackInfo): FileInfo[] {
  const modelDirs = [
    'app/Models',           // Laravel
    'src/models',           // Generic
    'models',               // Generic
    'src/entities',         // TypeORM
    'prisma',               // Prisma
    'app/models',           // Django/Rails
    'src/domain',           // DDD
  ];

  const models: FileInfo[] = [];
  for (const dir of modelDirs) {
    const fullDir = join(projectDir, dir);
    if (existsSync(fullDir)) {
      try {
        const files = readdirSync(fullDir).filter(
          (f) => /\.(php|ts|js|py|rb|go)$/.test(f) && !f.startsWith('.')
        );
        for (const file of files) {
          const filePath = join(fullDir, file);
          models.push({
            path: filePath.replace(projectDir + '/', ''),
            name: basename(file, extname(file)),
            size: statSync(filePath).size,
          });
        }
      } catch {}
    }
  }

  // Prisma schema
  const prismaSchema = join(projectDir, 'prisma', 'schema.prisma');
  if (existsSync(prismaSchema)) {
    models.push({ path: 'prisma/schema.prisma', name: 'PrismaSchema', size: statSync(prismaSchema).size });
  }

  return models;
}

// ── Routes ───────────────────────────────────

export function findRoutes(projectDir: string, stack: StackInfo): RouteInfo[] {
  const routes: RouteInfo[] = [];

  // Laravel routes
  for (const [file, type] of [['routes/web.php', 'web'], ['routes/api.php', 'api']] as const) {
    const fullPath = join(projectDir, file);
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, 'utf-8');
      const count = (content.match(/Route::(get|post|put|patch|delete|resource|apiResource|middleware|group)/gi) || []).length;
      routes.push({ file, count, type });
    }
  }

  // Express/Fastify routes
  const srcRoutes = join(projectDir, 'src', 'routes');
  if (existsSync(srcRoutes)) {
    try {
      const files = readdirSync(srcRoutes).filter((f) => /\.(ts|js)$/.test(f));
      for (const file of files) {
        const content = readFileSync(join(srcRoutes, file), 'utf-8');
        const count = (content.match(/\.(get|post|put|patch|delete)\(/gi) || []).length;
        routes.push({ file: `src/routes/${file}`, count, type: 'api' });
      }
    } catch {}
  }

  // Next.js pages/app directory
  for (const dir of ['pages/api', 'app/api', 'src/app/api']) {
    const fullDir = join(projectDir, dir);
    if (existsSync(fullDir)) {
      const count = countFilesRecursive(fullDir, /\.(ts|js|tsx|jsx)$/);
      routes.push({ file: dir, count, type: 'api' });
    }
  }

  return routes;
}

// ── Migrations ───────────────────────────────

export function findMigrations(projectDir: string): FileInfo[] {
  const migrationDirs = [
    'database/migrations',   // Laravel
    'prisma/migrations',     // Prisma
    'migrations',            // Generic
    'db/migrate',            // Rails
    'src/migrations',        // TypeORM
    'alembic/versions',      // Python/Alembic
  ];

  for (const dir of migrationDirs) {
    const fullDir = join(projectDir, dir);
    if (existsSync(fullDir)) {
      try {
        return readdirSync(fullDir)
          .filter((f) => !f.startsWith('.') && f !== '.gitkeep')
          .map((f) => ({
            path: `${dir}/${f}`,
            name: f,
            size: statSync(join(fullDir, f)).size,
          }));
      } catch {}
    }
  }

  return [];
}

// ── Tests ────────────────────────────────────

export function detectTests(projectDir: string, stack: StackInfo): TestInfo {
  const allDeps = { ...stack.dependencies, ...stack.devDependencies };

  // Framework detection
  let framework: string | null = null;
  if (allDeps['vitest']) framework = 'Vitest';
  else if (allDeps['jest']) framework = 'Jest';
  else if (allDeps['mocha']) framework = 'Mocha';
  else if (allDeps['phpunit/phpunit']) framework = 'PHPUnit';
  else if (allDeps['pytest']) framework = 'pytest';
  else if (allDeps['rspec']) framework = 'RSpec';

  // Directory detection
  const testDirs = ['tests', 'test', '__tests__', 'spec', 'src/__tests__'];
  let directory: string | null = null;
  let fileCount = 0;

  for (const dir of testDirs) {
    const fullDir = join(projectDir, dir);
    if (existsSync(fullDir)) {
      directory = dir;
      fileCount = countFilesRecursive(fullDir, /\.(test|spec)\.(ts|js|tsx|jsx|php|py|rb)$|Test\.php$/);
      break;
    }
  }

  return { framework, directory, fileCount };
}

// ── Config ───────────────────────────────────

export function detectConfig(projectDir: string): ConfigInfo {
  const envExample = existsSync(join(projectDir, '.env.example'));
  let configDir: string | null = null;

  for (const dir of ['config', 'src/config', '.config']) {
    if (existsSync(join(projectDir, dir))) {
      configDir = dir;
      break;
    }
  }

  // Extract env var names from .env.example
  let envVars: string[] = [];
  if (envExample) {
    const content = readFileSync(join(projectDir, '.env.example'), 'utf-8');
    envVars = content
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l.trim()))
      .map((l) => l.split('=')[0]!.trim())
      .slice(0, 30); // Cap at 30
  }

  return { envExample, configDir, envVars };
}

// ── CI/CD ────────────────────────────────────

export function detectCiCd(projectDir: string): FileInfo[] {
  const files: FileInfo[] = [];

  const candidates = [
    '.github/workflows',
    '.gitlab-ci.yml',
    '.circleci/config.yml',
    'Jenkinsfile',
    'Dockerfile',
    'docker-compose.yml',
    'docker-compose.yaml',
    'Makefile',
    'Procfile',
    'fly.toml',
    'vercel.json',
    'netlify.toml',
    'render.yaml',
  ];

  for (const candidate of candidates) {
    const fullPath = join(projectDir, candidate);
    if (existsSync(fullPath)) {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        try {
          const entries = readdirSync(fullPath).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
          for (const entry of entries) {
            files.push({
              path: `${candidate}/${entry}`,
              name: entry,
              size: statSync(join(fullPath, entry)).size,
            });
          }
        } catch {}
      } else {
        files.push({ path: candidate, name: basename(candidate), size: stat.size });
      }
    }
  }

  return files;
}

// ── Key Files (most important to understand) ─

export function findKeyFiles(projectDir: string, stack: StackInfo): FileInfo[] {
  const keyFiles: FileInfo[] = [];
  const candidates: string[] = [];

  // Universal
  candidates.push('README.md', 'CLAUDE.md', '.cursorrules');

  // Framework-specific key files
  if (stack.framework === 'Laravel') {
    candidates.push(
      'routes/web.php', 'routes/api.php',
      'app/Providers/AppServiceProvider.php',
      'config/app.php', 'config/database.php',
      'bootstrap/app.php',
    );
  } else if (stack.framework === 'Next.js') {
    candidates.push(
      'next.config.js', 'next.config.ts', 'next.config.mjs',
      'src/app/layout.tsx', 'src/app/page.tsx',
      'app/layout.tsx', 'app/page.tsx',
    );
  } else if (stack.framework === 'Express' || stack.framework === 'Fastify') {
    candidates.push('src/app.ts', 'src/server.ts', 'src/index.ts');
  } else if (stack.framework === 'Django') {
    candidates.push('manage.py', 'settings.py', 'urls.py');
  }

  // Always include service/controller directories listing
  const serviceDirs = ['app/Services', 'app/Http/Controllers', 'src/services', 'src/controllers', 'src/lib'];
  for (const dir of serviceDirs) {
    const fullDir = join(projectDir, dir);
    if (existsSync(fullDir)) {
      try {
        const files = readdirSync(fullDir).filter((f) => /\.(php|ts|js|py)$/.test(f)).slice(0, 10);
        for (const file of files) {
          candidates.push(`${dir}/${file}`);
        }
      } catch {}
    }
  }

  for (const candidate of candidates) {
    const fullPath = join(projectDir, candidate);
    if (existsSync(fullPath) && statSync(fullPath).isFile()) {
      keyFiles.push({
        path: candidate,
        name: basename(candidate),
        size: statSync(fullPath).size,
      });
    }
  }

  return keyFiles;
}

// ── Helpers ──────────────────────────────────

function countFilesRecursive(dir: string, pattern: RegExp): number {
  let count = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'vendor') {
        count += countFilesRecursive(join(dir, entry.name), pattern);
      } else if (entry.isFile() && pattern.test(entry.name)) {
        count++;
      }
    }
  } catch {}
  return count;
}
