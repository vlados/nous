import type { KnowledgeType } from '../knowledge/types.js';

export interface ClassificationResult {
  type: KnowledgeType;
  confidence: number;
  title: string;
  content: string;
  signals: string[];
}

interface Signal {
  pattern: RegExp;
  type: KnowledgeType;
  weight: number;
  label: string;
}

const SIGNALS: Signal[] = [
  // Decision signals
  { pattern: /\bwe chose\b/i, type: 'decision', weight: 0.9, label: 'we chose' },
  { pattern: /\bdecided to\b/i, type: 'decision', weight: 0.9, label: 'decided to' },
  { pattern: /\bopted for\b/i, type: 'decision', weight: 0.85, label: 'opted for' },
  { pattern: /\binstead of\b/i, type: 'decision', weight: 0.7, label: 'instead of' },
  { pattern: /\btradeoff\b/i, type: 'decision', weight: 0.8, label: 'tradeoff' },
  { pattern: /\btrade-off\b/i, type: 'decision', weight: 0.8, label: 'trade-off' },
  { pattern: /\bruled out\b/i, type: 'decision', weight: 0.8, label: 'ruled out' },
  { pattern: /\bthe reason\b/i, type: 'decision', weight: 0.7, label: 'the reason' },
  { pattern: /\bbecause\b.*\bchose\b/i, type: 'decision', weight: 0.85, label: 'because...chose' },
  { pattern: /\bover\b.*\bbecause\b/i, type: 'decision', weight: 0.75, label: 'over...because' },
  { pattern: /\balternative was\b/i, type: 'decision', weight: 0.8, label: 'alternative was' },

  // Concept signals
  { pattern: /\bworks by\b/i, type: 'concept', weight: 0.9, label: 'works by' },
  { pattern: /\bthe flow is\b/i, type: 'concept', weight: 0.85, label: 'the flow is' },
  { pattern: /\barchitecture\b/i, type: 'concept', weight: 0.6, label: 'architecture' },
  { pattern: /\bresponsible for\b/i, type: 'concept', weight: 0.7, label: 'responsible for' },
  { pattern: /\bhandles\b.*\bby\b/i, type: 'concept', weight: 0.65, label: 'handles...by' },
  { pattern: /\bconnects to\b/i, type: 'concept', weight: 0.7, label: 'connects to' },
  { pattern: /\bcomponent\b/i, type: 'concept', weight: 0.5, label: 'component' },
  { pattern: /\bdata flows?\b/i, type: 'concept', weight: 0.7, label: 'data flow' },
  { pattern: /\bhow\b.*\bwork/i, type: 'concept', weight: 0.8, label: 'how...work' },
  { pattern: /\bthe\b.*\bsystem\b/i, type: 'concept', weight: 0.4, label: 'the...system' },

  // Pattern signals
  { pattern: /\balways\b/i, type: 'pattern', weight: 0.7, label: 'always' },
  { pattern: /\bnever\b/i, type: 'pattern', weight: 0.7, label: 'never' },
  { pattern: /\bconvention\b/i, type: 'pattern', weight: 0.85, label: 'convention' },
  { pattern: /\brule\b/i, type: 'pattern', weight: 0.6, label: 'rule' },
  { pattern: /\bmake sure\b/i, type: 'pattern', weight: 0.65, label: 'make sure' },
  { pattern: /\bmust\b/i, type: 'pattern', weight: 0.5, label: 'must' },
  { pattern: /\bwhen doing\b/i, type: 'pattern', weight: 0.8, label: 'when doing' },
  { pattern: /\bdo not\b/i, type: 'pattern', weight: 0.55, label: 'do not' },
  { pattern: /\bavoid\b/i, type: 'pattern', weight: 0.55, label: 'avoid' },
  { pattern: /\bprefer\b/i, type: 'pattern', weight: 0.6, label: 'prefer' },
];

// Importance boosters (increase confidence regardless of type)
const BOOSTERS: { pattern: RegExp; bonus: number }[] = [
  { pattern: /```[\s\S]*?```/, bonus: 0.1 },        // Code blocks
  { pattern: /[a-zA-Z]+\.[a-z]{2,4}(?:\/\S+)?/, bonus: 0.05 }, // File paths
  { pattern: /\b(?:remember|note|important)\b:/i, bonus: 0.15 }, // Explicit teaching
  { pattern: /\b(?:gotcha|caveat|warning|careful)\b/i, bonus: 0.1 }, // Gotchas
];

/** Minimum score threshold to classify a segment. */
const THRESHOLD = 0.5;

/**
 * Classify a text segment as concept, decision, or pattern.
 * Returns null if confidence is below threshold.
 */
export function classify(text: string): ClassificationResult | null {
  const scores: Record<KnowledgeType, { total: number; signals: string[] }> = {
    concept: { total: 0, signals: [] },
    decision: { total: 0, signals: [] },
    pattern: { total: 0, signals: [] },
  };

  for (const signal of SIGNALS) {
    if (signal.pattern.test(text)) {
      scores[signal.type].total += signal.weight;
      scores[signal.type].signals.push(signal.label);
    }
  }

  // Find the winning type
  let bestType: KnowledgeType = 'concept';
  let bestScore = 0;

  for (const type of ['concept', 'decision', 'pattern'] as KnowledgeType[]) {
    if (scores[type].total > bestScore) {
      bestScore = scores[type].total;
      bestType = type;
    }
  }

  if (bestScore < THRESHOLD) return null;

  // Apply boosters
  let bonus = 0;
  for (const booster of BOOSTERS) {
    if (booster.pattern.test(text)) bonus += booster.bonus;
  }

  // Normalize confidence to 0-1 range (cap at 0.95 for auto-extracted)
  const confidence = Math.min(0.95, (bestScore + bonus) / 3);

  // Generate title from first meaningful sentence
  const title = generateTitle(text);

  return {
    type: bestType,
    confidence,
    title,
    content: text.trim(),
    signals: scores[bestType].signals,
  };
}

/**
 * Generate a short title from text.
 * Takes the first sentence, truncated to 60 chars.
 */
function generateTitle(text: string): string {
  const firstSentence = text.split(/[.!?\n]/)[0]?.trim() ?? text.trim();
  if (firstSentence.length <= 60) return firstSentence;
  return firstSentence.slice(0, 57) + '...';
}

/**
 * Segment a block of text into meaningful chunks for classification.
 * Splits by paragraph boundaries and merges short segments.
 */
export function segment(text: string): string[] {
  // Split by double newlines (paragraphs) or turn boundaries
  const rawSegments = text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30); // Skip very short segments

  // Merge segments that are too short (< 50 chars) with the next one
  const merged: string[] = [];
  let buffer = '';

  for (const seg of rawSegments) {
    if (buffer) {
      buffer += '\n\n' + seg;
      if (buffer.length >= 50) {
        merged.push(buffer);
        buffer = '';
      }
    } else if (seg.length < 50) {
      buffer = seg;
    } else {
      merged.push(seg);
    }
  }
  if (buffer) merged.push(buffer);

  return merged;
}
