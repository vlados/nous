import { describe, it, expect } from 'vitest';
import { classify, segment } from '../src/extraction/classifier.js';

describe('classifier', () => {
  it('classifies decision statements', () => {
    const result = classify('We decided to use SQLite over PostgreSQL because portability matters more');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('decision');
  });

  it('classifies concept explanations', () => {
    const result = classify('The authentication system works by using JWT tokens with refresh rotation');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('concept');
  });

  it('classifies patterns', () => {
    const result = classify('Always use the ApiResponse wrapper class for all REST API responses');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('pattern');
  });

  it('classifies "never" patterns', () => {
    const result = classify('Never return raw arrays or objects from controllers in the API layer');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('pattern');
  });

  it('classifies "opted for" as decision', () => {
    const result = classify('We opted for Redis over Memcached because we need pub/sub capabilities');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('decision');
  });

  it('returns null for unclassifiable text', () => {
    const result = classify('The weather is nice today and I had coffee this morning');
    expect(result).toBeNull();
  });

  it('returns null for very short text', () => {
    const result = classify('yes');
    expect(result).toBeNull();
  });

  it('boosts confidence for text with code blocks', () => {
    const withCode = classify('We decided to use ```npm install sqlite-vec``` because portability matters');
    const without = classify('We decided to use SQLite because portability matters');
    expect(withCode).not.toBeNull();
    expect(without).not.toBeNull();
    expect(withCode!.confidence).toBeGreaterThan(without!.confidence);
  });

  it('generates a title from the first sentence', () => {
    const result = classify('We decided to use Redis for caching. It supports pub/sub which we need for real-time features.');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('We decided to use Redis for caching');
  });

  it('truncates long titles to 60 chars', () => {
    const result = classify('We decided to use a really long technology name that goes on and on because of very specific requirements for our project');
    expect(result).not.toBeNull();
    expect(result!.title.length).toBeLessThanOrEqual(60);
  });
});

describe('segment', () => {
  it('splits text by paragraphs', () => {
    const text = 'This is the first paragraph that talks about something important and meaningful.\n\nThis is the second paragraph about a different topic that is also quite long.';
    const segments = segment(text);
    expect(segments).toHaveLength(2);
  });

  it('filters out very short segments', () => {
    const text = 'Short.\n\nThis is a meaningful paragraph about the architecture of the system and how it works together.';
    const segments = segment(text);
    expect(segments).toHaveLength(1);
  });

  it('merges short segments with next', () => {
    const text = 'Important note about this.\n\nThe system architecture works by connecting multiple services together through a message bus.';
    const segments = segment(text);
    // The short first segment should merge with the second
    expect(segments.length).toBeLessThanOrEqual(2);
  });
});
