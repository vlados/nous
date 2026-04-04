import { createServer } from 'node:http';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getConnection, closeConnection } from '../db/connection.js';
import { findNousDir, loadConfig } from '../utils/config.js';
import { OpenAIEmbeddingEngine } from '../embeddings/api.js';
import { FallbackEmbeddingEngine } from '../embeddings/fallback.js';
import { BrainApi } from './api.js';
import type { EmbeddingEngine } from '../embeddings/engine.js';

export function startVizServer(port: number = 4200): { url: string; close: () => void } {
  const nousDir = findNousDir();
  if (!nousDir) {
    throw new Error('No .nous/ directory found. Run `nous init` first.');
  }

  const config = loadConfig(nousDir);
  const dbPath = join(nousDir, 'knowledge.db');
  const db = getConnection(dbPath);

  const apiKey = config.openai_api_key ?? process.env['OPENAI_API_KEY'];
  const embeddings: EmbeddingEngine = apiKey
    ? new OpenAIEmbeddingEngine(apiKey)
    : new FallbackEmbeddingEngine();

  const api = new BrainApi(db, embeddings);

  // Load the HTML frontend
  const currentDir = fileURLToPath(new URL('.', import.meta.url));
  let html: string;
  try {
    html = readFileSync(join(currentDir, 'index.html'), 'utf-8');
  } catch {
    // When running via tsx, resolve from src/viz/
    try {
      html = readFileSync(join(currentDir, '../../src/viz/index.html'), 'utf-8');
    } catch {
      html = '<html><body><h1>nous brain</h1><p>index.html not found</p></body></html>';
    }
  }

  // Inject project name into HTML
  html = html.replace('{{PROJECT_NAME}}', config.project_name || 'nous');

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/';

    if (url.startsWith('/api/')) {
      await api.handle(req, res);
      return;
    }

    // Serve the frontend for all other routes
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  server.listen(port);

  const vizUrl = `http://localhost:${port}`;

  return {
    url: vizUrl,
    close: () => {
      server.close();
      closeConnection();
    },
  };
}
