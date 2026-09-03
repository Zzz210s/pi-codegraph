# pi-codegraph

**English | [简体中文](./README.zh-CN.md)**

A local code-search extension for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent): tree-sitter extracts symbols and call edges, SQLite stores the graph. Registers four tools - `code_find` / `code_trace` / `code_impact` / `code_map` - plus the `/reindex` and `/code doctor` commands. Zero models, zero network, all local computation.

## Contents

- [Background](#background)
- [Install](#install)
- [Usage](#usage)
- [Limits](#limits)
- [Architecture](#architecture)
- [Development](#development)

## Background

Locating code in an unfamiliar repo usually means many rounds of grep plus file-by-file reading - lots of turns, lots of wasted context. codegraph indexes the whole repo's symbol table and call graph into SQLite once, then:

- Know (or guess) a symbol name -> one `code_find` jumps straight to the definition line
- Follow call chains -> `code_trace` (callers/callees) replaces multiple grep rounds
- Gauge a change's blast radius -> `code_impact` lists affected files, symbols, and tests
- Map an unfamiliar repo -> `code_map` renders a PageRank-ranked overview

Measured cold-index times: aider (151 files) 952ms, hono (355 files) 2.2s, cobra (36 files) 0.4s.

## Install

Requirements: Node >= 24 (extension loading and unit tests rely on native TS type stripping), pi installed. Native modules (tree-sitter family, better-sqlite3) need a local build toolchain.

```bash
pi install npm:@zzz210s/pi-codegraph
# or from git:
pi install git:github.com/Zzz210s/pi-codegraph
```

Manual install:

```bash
git clone https://github.com/Zzz210s/pi-codegraph.git ~/pi-codegraph
bash ~/pi-codegraph/setup.sh
```

Restart pi (or run /reload inside pi) to activate.

## Usage

Inside a pi session:

- `code_find` - find definitions by symbol name (exact/prefix/substring); returns `file:line kind name signature`, hub files ranked first
- `code_trace` - who calls X / what X calls (direction=callers/callees)
- `code_impact` - blast radius of a change: affected files, symbols, tests (target = file path or symbol name)
- `code_map` - repo overview: files ranked by PageRank centrality with key symbol signatures
- `/reindex <repo-root>` - build the index (cold indexing is fast, ~1s for 151 files)
- `/code doctor` - environment and index health check (dependencies, index state)

Run `/reindex <repo-root>` the first time you use it in a repo. The index lives in the repo-local `.codegraph/` directory (recommended to add to the project's .gitignore).

Languages supported: Python / TypeScript / TSX / Go / Java.

## Limits

No configuration needed. Known boundaries:

- `code_find` on generic names (e.g. `run`) guarantees hub-first ranking, not semantic perfection
- monkeypatched / attribute-style calls produce no call edges
- Go / Java directory-level imports do not resolve to files (callee_file may be null)
- no hot-path caching (queries stay <10ms at current scale, acceptable)

## Architecture

Single-responsibility modules, every file <= 200 lines, pure logic separated from side effects:

- `index.ts` - extension entry: registers tools and commands
- `parse*.ts` - per-language tree-sitter parsing (symbols/call extraction); `parse.ts` dispatches
- `indexer.ts` / `graph.ts` / `edges.ts` - graph construction: parse output -> symbol table + call edges
- `pagerank.ts` - centrality ranking (hub-first for code_find / code_map)
- `store.ts` / `store-io.ts` - SQLite access, migration, and validation
- `find.ts` / `trace.ts` / `blast.ts` / `map.ts` - core query logic for the four tools
- `tool-*.ts` - tool parameter schemas and output formatting
- `doctor.ts` / `command-*.ts` - /code doctor and /reindex command implementations
- `*.test.js` - 19 test files (node --test, 80+ cases)

## Development

```bash
cd extensions/codegraph
npm install        # includes dev dependencies
npm test           # node --test, all cases
```

```bash
bash setup.sh --test   # run tests, then deploy to ~/.pi/agent/extensions/codegraph/
```

After changes, /reload hot-reloads; re-run /reindex when the index is stale. If the index database is corrupted, the tools return a hint to delete .codegraph/ and /reindex.

## License

MIT
