import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { CreateKnowledgeInput, KnowledgeType } from '../knowledge/types.js';

export interface ImportSource {
  name: string;
  path: string;
  type: 'claude-md' | 'readme' | 'cursorrules' | 'adr' | 'generic-md';
}

/**
 * Auto-detect importable knowledge sources in the project.
 */
export function detectSources(projectDir: string): ImportSource[] {
  const sources: ImportSource[] = [];

  const checks: { paths: string[]; name: string; type: ImportSource['type'] }[] = [
    { paths: ['CLAUDE.md'], name: 'CLAUDE.md', type: 'claude-md' },
    { paths: ['README.md', 'readme.md', 'Readme.md'], name: 'README', type: 'readme' },
    { paths: ['.cursorrules', '.cursor/rules'], name: 'Cursor Rules', type: 'cursorrules' },
  ];

  for (const check of checks) {
    for (const p of check.paths) {
      const fullPath = join(projectDir, p);
      if (existsSync(fullPath)) {
        sources.push({ name: check.name, path: fullPath, type: check.type });
        break;
      }
    }
  }

  // Check for ADR directory
  const adrPaths = ['docs/adr', 'doc/adr', 'docs/decisions', 'adr'];
  for (const adrDir of adrPaths) {
    const fullDir = join(projectDir, adrDir);
    if (existsSync(fullDir)) {
      try {
        const files = readdirSync(fullDir).filter((f) => f.endsWith('.md'));
        for (const file of files) {
          sources.push({
            name: `ADR: ${basename(file, '.md')}`,
            path: join(fullDir, file),
            type: 'adr',
          });
        }
      } catch {}
      break;
    }
  }

  return sources;
}

/**
 * Parse a CLAUDE.md file into knowledge entries.
 * Splits by ## headings, classifies sections.
 */
export function parseClaudeMd(content: string, filePath: string): CreateKnowledgeInput[] {
  const entries: CreateKnowledgeInput[] = [];
  const sections = splitByHeadings(content);

  for (const section of sections) {
    if (section.body.trim().length < 20) continue;

    // Classify based on heading and content
    const type = classifySection(section.heading, section.body);
    entries.push({
      type,
      title: section.heading || 'Project Rules',
      content: section.body.trim(),
      source: 'imported',
      source_ref: filePath,
      tags: ['imported', 'claude-md'],
      confidence: 0.9,
    });
  }

  return entries;
}

/**
 * Parse a README.md into knowledge entries.
 * Extracts architecture, setup, and key sections.
 */
export function parseReadme(content: string, filePath: string): CreateKnowledgeInput[] {
  const entries: CreateKnowledgeInput[] = [];
  const sections = splitByHeadings(content);

  // Skip generic sections (badges, license, contributing)
  const skipPatterns = /^(license|contributing|contributors|changelog|table of contents|acknowledgements?|badge)/i;

  for (const section of sections) {
    if (section.body.trim().length < 30) continue;
    if (skipPatterns.test(section.heading)) continue;

    const type = classifySection(section.heading, section.body);
    entries.push({
      type,
      title: section.heading || 'Project Overview',
      content: section.body.trim().slice(0, 2000), // Cap length for README sections
      source: 'imported',
      source_ref: filePath,
      tags: ['imported', 'readme'],
      confidence: 0.8,
    });
  }

  return entries;
}

/**
 * Parse .cursorrules into pattern entries.
 */
export function parseCursorRules(content: string, filePath: string): CreateKnowledgeInput[] {
  const entries: CreateKnowledgeInput[] = [];

  // Cursor rules are typically one rule per line or per paragraph
  const lines = content.split('\n').filter((l) => l.trim().length > 15);

  // Group consecutive non-empty lines into paragraphs
  let current = '';
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.trim().length > 20) {
        entries.push({
          type: 'pattern',
          title: current.trim().split('\n')[0]!.slice(0, 60),
          content: current.trim(),
          source: 'imported',
          source_ref: filePath,
          tags: ['imported', 'cursorrules'],
          confidence: 0.85,
        });
      }
      current = '';
    } else {
      current += (current ? '\n' : '') + line;
    }
  }

  // Don't forget last paragraph
  if (current.trim().length > 20) {
    entries.push({
      type: 'pattern',
      title: current.trim().split('\n')[0]!.slice(0, 60),
      content: current.trim(),
      source: 'imported',
      source_ref: filePath,
      tags: ['imported', 'cursorrules'],
      confidence: 0.85,
    });
  }

  return entries;
}

/**
 * Parse an ADR (Architecture Decision Record) into a decision entry.
 */
export function parseAdr(content: string, filePath: string): CreateKnowledgeInput[] {
  // ADRs typically have: Title, Status, Context, Decision, Consequences
  const titleMatch = content.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1]!.trim() : basename(filePath, '.md');

  return [
    {
      type: 'decision',
      title,
      content: content.trim().slice(0, 3000),
      source: 'imported',
      source_ref: filePath,
      tags: ['imported', 'adr'],
      confidence: 0.95,
    },
  ];
}

/**
 * Parse a generic markdown file.
 */
export function parseGenericMd(content: string, filePath: string): CreateKnowledgeInput[] {
  const sections = splitByHeadings(content);
  const entries: CreateKnowledgeInput[] = [];

  for (const section of sections) {
    if (section.body.trim().length < 30) continue;

    entries.push({
      type: classifySection(section.heading, section.body),
      title: section.heading || basename(filePath, '.md'),
      content: section.body.trim().slice(0, 2000),
      source: 'imported',
      source_ref: filePath,
      tags: ['imported'],
      confidence: 0.7,
    });
  }

  return entries;
}

// ── Helpers ──────────────────────────────────

interface Section {
  heading: string;
  body: string;
}

function splitByHeadings(content: string): Section[] {
  const sections: Section[] = [];
  const lines = content.split('\n');
  let currentHeading = '';
  let currentBody = '';

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      // Save previous section
      if (currentBody.trim()) {
        sections.push({ heading: currentHeading, body: currentBody });
      }
      currentHeading = headingMatch[1]!.trim();
      currentBody = '';
    } else {
      currentBody += line + '\n';
    }
  }

  // Last section
  if (currentBody.trim()) {
    sections.push({ heading: currentHeading, body: currentBody });
  }

  return sections;
}

function classifySection(heading: string, body: string): KnowledgeType {
  const h = heading.toLowerCase();
  const b = body.toLowerCase();

  // Decision signals in heading
  if (/decision|chose|why|rationale|tradeoff|alternative/.test(h)) return 'decision';

  // Pattern signals in heading
  if (/rule|convention|pattern|guideline|standard|must|never|always/.test(h)) return 'pattern';

  // Pattern signals in body (rules-heavy sections)
  const patternCount = (b.match(/\b(always|never|must|do not|convention|rule)\b/g) || []).length;
  if (patternCount >= 3) return 'pattern';

  // Decision signals in body
  const decisionCount = (b.match(/\b(decided|chose|because|instead of|opted)\b/g) || []).length;
  if (decisionCount >= 2) return 'decision';

  // Default to concept
  return 'concept';
}
