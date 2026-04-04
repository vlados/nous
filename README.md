# nous

[![npm version](https://img.shields.io/npm/v/nousdb.svg)](https://www.npmjs.com/package/nousdb)
[![npm downloads](https://img.shields.io/npm/dm/nousdb.svg)](https://www.npmjs.com/package/nousdb)
[![license](https://img.shields.io/npm/l/nousdb.svg)](https://github.com/vlados/nous/blob/main/LICENSE)

Your project's brain. One command to set up. Zero config to start.

```bash
npx nousdb init --hook
```

That's it. Your AI assistant now has a persistent memory for this project — it learns from your conversations and remembers how things work.

---

## What is this?

Every project has knowledge that lives in developers' heads: *how the payment flow works*, *why we chose Redis over Memcached*, *the rule about never pushing to main*. This knowledge gets lost between sessions, forgotten by new team members, and never reaches your AI tools.

**nous** fixes that. It's a single SQLite file (`.nous/knowledge.db`) that stores your project's knowledge and makes it queryable by any AI via [MCP](https://modelcontextprotocol.io).

## 30-second setup

```bash
cd your-project
npx nousdb init --hook
```

This creates:

```
.nous/knowledge.db        ← the brain (commit to git, share with team)
.claude/settings.json     ← Claude Code connects automatically
```

**Done.** Just start Claude Code normally — nous is already connected. No server to run, no extra terminal.

> Without `--hook`, you get query-only (no auto-learning).
> Without Claude Code, you can still use the CLI to teach and search.

## How it works

### Your AI can query the brain

After `init`, Claude Code has 10 MCP tools available. The most useful:

```
You: "I need to add retry logic to the payment flow"

Claude Code calls nous_context("add retry logic to payment flow")
  → returns relevant concepts, decisions, and patterns
  → Claude now knows how payments work before writing a single line
```

### Your conversations teach the brain

With `--hook`, nous listens to every conversation (async, non-blocking):

```
You: "We decided to use Redis for caching because we need pub/sub"
Claude: [implements the feature]

                    ↓ Stop hook fires (background)
                    ↓ reads conversation transcript
                    ↓ heuristic classifier detects "we decided to..."
                    ↓ saves as decision with confidence: 0.6

Next session:
You: "How does caching work?"
Claude Code calls nous_query("caching")
  → "We decided to use Redis for caching because we need pub/sub"
```

No manual effort. You just have conversations and the brain learns.

### You can teach it directly

```bash
# How something works
npx nousdb teach concept "Payment Flow" \
  "Stripe webhooks hit PaymentController, which dispatches to OrderService"

# Why a decision was made
npx nousdb teach decision "Chose SQLite" \
  "Portability over scale — the brain file lives in git"

# Rules to follow
npx nousdb teach pattern "API Responses" \
  "Always use ApiResponse wrapper, never return raw arrays"
```

## Three knowledge types

| Type | When to use | Signals |
|------|------------|---------|
| **concept** | How something works | "works by", "the flow is", "responsible for" |
| **decision** | Why something was chosen | "we decided", "opted for", "instead of" |
| **pattern** | Rules to follow | "always", "never", "make sure", "convention" |

## Search

```bash
npx nousdb ask "payment"
```

nous uses **hybrid search**: FTS5 keyword matching + vector semantic search (OpenAI embeddings) + Reciprocal Rank Fusion to merge results. Entries found by both methods get boosted.

Works without an API key too — falls back to keyword search only.

### Semantic search (optional)

For semantic search ("how do we process charges" finds "Payment Flow"), set your OpenAI key:

```bash
export OPENAI_API_KEY=sk-...
```

Without it, everything works — you just get keyword matching instead of semantic.

## Sharing with your team

The `.nous/knowledge.db` file is designed to be committed to git:

- `init` adds `merge=binary` to `.gitattributes` automatically
- No WAL sidecar files (journal mode = DELETE)
- ~2.5MB per 1,000 entries
- Every team member and every AI tool gets the same project knowledge

## MCP tools

After `init`, Claude Code (or any MCP client) gets these tools:

| Tool | What it does |
|------|-------------|
| `nous_query` | Search the brain (hybrid keyword + semantic) |
| `nous_teach` | Add new knowledge |
| `nous_recall` | Get entry by ID or exact title |
| `nous_update` | Update existing entry |
| `nous_relate` | Create/query relationships between entries |
| `nous_forget` | Deprecate or delete entries |
| `nous_context` | Get all relevant knowledge for a task description |
| `nous_extract` | Extract knowledge from a block of text |
| `nous_recent` | Recently added/modified entries |
| `nous_status` | Brain stats and health |

### Manual MCP setup (if not using `init`)

```bash
claude mcp add nous -- npx nousdb serve
```

> You never need to run `nous serve` yourself. Claude Code starts it automatically in the background via the config in `.claude/settings.json`.

## CLI reference

```bash
npx nousdb init                             # Interactive setup wizard
npx nousdb init --import --hook             # Non-interactive, all features
npx nousdb status                           # Brain statistics
npx nousdb teach <type> <title> <content>   # Add knowledge
npx nousdb ask <question>                   # Search the brain
npx nousdb import [file]                    # Import from CLAUDE.md, README, ADRs
npx nousdb viz                              # Open brain visualization in browser
npx nousdb export [--format json|markdown]  # Export for backup or docs
npx nousdb extract --stdin [--auto-save]    # Extract knowledge from piped text
```

## How auto-learning works

When you run `init --hook`, nous installs a **Stop hook** in Claude Code:

1. After every Claude response, the hook fires (async, non-blocking)
2. It reads the conversation transcript (`transcript_path` JSONL)
3. A heuristic classifier scans for decision/concept/pattern signals
4. New knowledge is saved with `confidence: 0.6` and `source: extracted`
5. Deduplication prevents the same knowledge from being stored twice

The classifier uses ~30 regex patterns (no LLM calls, zero cost, <10ms). It's intentionally conservative — better to miss knowledge than add noise. You can always teach it directly.

## What gets created

```
your-project/
├── .nous/
│   ├── knowledge.db      ← the brain (commit this)
│   ├── config.json       ← settings + API key (commit this)
│   └── .gitignore        ← excludes WAL/journal files
├── .claude/
│   ├── settings.json     ← Claude Code auto-connects (no manual server needed)
│   └── hooks/
│       └── nous-extract.sh  ← auto-learning script (with --hook)
└── .gitattributes        ← binary merge strategy for .db
```

## License

MIT
