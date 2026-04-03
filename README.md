# nous

Per-project knowledge brain with auto-learning from AI conversations.

**nous** (Greek for "mind") stores everything a developer needs to know about a project — how things work, why decisions were made, and what patterns to follow — in a single SQLite file that lives in your repo.

Any AI tool can query it via MCP. Knowledge is auto-extracted from Claude Code conversations.

## Quick Start

```bash
# Initialize in your project
npx nousdb init --name "my-project"

# Start the MCP server (add to Claude Code / Cursor)
npx nousdb serve

# Teach it something
npx nousdb teach concept "Payment Flow" "Stripe webhooks hit PaymentController, which dispatches to OrderService"
npx nousdb teach decision "Chose SQLite" "Portability over scale — the brain file lives in git"
npx nousdb teach pattern "API Responses" "Always use ApiResponse wrapper, never return raw arrays"

# Search
npx nousdb ask "how do payments work"

# See brain stats
npx nousdb status
```

## Three Knowledge Types

| Type | What it captures | Example |
|------|-----------------|---------|
| **concept** | How something works | "The auth system uses JWT with refresh rotation" |
| **decision** | Why something was chosen | "We chose Redis over Memcached for pub/sub support" |
| **pattern** | When/always/never rules | "Always use wire:navigate for Livewire navigation" |

## MCP Integration

Add nous to your Claude Code or Cursor config:

```json
{
  "mcpServers": {
    "nous": {
      "type": "stdio",
      "command": "npx",
      "args": ["nousdb", "serve"]
    }
  }
}
```

### 10 MCP Tools

| Tool | What it does |
|------|-------------|
| `nous_query` | Hybrid search (keyword + semantic + RRF reranking) |
| `nous_teach` | Add new knowledge |
| `nous_recall` | Get entry by ID or title |
| `nous_update` | Update existing entry |
| `nous_relate` | Create/query relationships between entries |
| `nous_forget` | Deprecate or delete entries |
| `nous_context` | Get all relevant knowledge for a task (concepts + decisions + patterns) |
| `nous_extract` | Extract knowledge from conversation text |
| `nous_recent` | Recently added/modified entries |
| `nous_status` | Brain stats and health |

## Auto-Learning from AI Conversations

The killer feature. Initialize with the `--hook` flag to add a Claude Code hook:

```bash
npx nousdb init --hook
```

This adds a `PostToolUse` hook that watches Write/Edit operations and auto-extracts decisions, concepts, and patterns from conversations. Knowledge is stored with `confidence: 0.6` and `source: extracted`.

You can also pipe text manually:

```bash
echo "We decided to use SQLite because portability matters" | npx nousdb extract --stdin --auto-save
```

## How Search Works

nous uses **hybrid search** combining three strategies:

1. **FTS5** — SQLite full-text search with BM25 ranking (keyword matching)
2. **sqlite-vec** — Vector similarity search using OpenAI embeddings (semantic matching)
3. **Reciprocal Rank Fusion** — Merges results from both, boosting entries found by both methods

When no OpenAI API key is configured, search falls back to FTS5-only (still works, just keyword-based).

## Embeddings

Set your OpenAI API key for semantic search:

```bash
export OPENAI_API_KEY=sk-...
```

Or add it to `.nous/config.json`:

```json
{
  "openai_api_key": "sk-..."
}
```

Without an API key, nous works perfectly with keyword search only.

## Git Integration

The `.nous/knowledge.db` file is designed to be committed to git:

- `nous init` adds `.nous/knowledge.db binary merge=binary` to `.gitattributes`
- Journal mode is DELETE (not WAL) — no sidecar files
- ~2.5MB per 1000 entries — well within git's comfort zone
- Team members share the same project knowledge

## Export

```bash
# Markdown (human-readable docs)
npx nousdb export --format markdown

# JSON (backup/migration)
npx nousdb export --format json -o brain-backup.json
```

## Project Structure

```
.nous/                     # Created by `nous init` (committed to git)
├── knowledge.db           # SQLite + sqlite-vec + FTS5
├── config.json            # Project settings
└── .gitignore             # Excludes WAL/journal files
```

## CLI Commands

```
nous init [--name <name>] [--hook]    Create .nous/ directory, optionally add Claude Code hook
nous serve                             Start MCP server (stdio)
nous status                            Brain statistics
nous teach <type> <title> <content>    Add knowledge (type: concept, decision, pattern)
nous ask <question>                    Search the brain
nous export [--format json|markdown]   Export brain contents
nous extract --stdin [--auto-save]     Extract knowledge from piped text
```

## License

MIT
