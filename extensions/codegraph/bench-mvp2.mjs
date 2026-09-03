// bench-mvp2.mjs - manual benchmark for MVP-2 decision gates (not a test).
// Usage: node bench-mvp2.mjs <repoRoot> [runs]
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { indexRepo } from './indexer.ts';
import { codeFind } from './find.ts';
import { codeMap } from './map.ts';
import { openStore } from './store.ts';
import { traceCallers } from './trace.ts';

const root = process.argv[2];
const runs = Number(process.argv[3] ?? 3);
if (!root) {
  console.error('usage: node bench-mvp2.mjs <repoRoot> [runs]');
  process.exit(1);
}

const times = [];
let last = null;
for (let i = 0; i < runs; i++) {
  rmSync(join(root, '.codegraph'), { recursive: true, force: true });
  const t0 = performance.now();
  last = indexRepo(root);
  times.push(Math.round(performance.now() - t0));
}
const store = openStore(join(root, '.codegraph', 'index.sqlite'));
const edges = store.getAllEdges();
console.log(
  `INDEX files=${last.files} symbols=${last.symbols} edges=${edges.length} ` +
    `imports=${edges.filter((e) => e.kind === 'import').length} ` +
    `coldMs=${times.join('/')}`
);
store.close();

// warm (incremental) run timing
const t1 = performance.now();
const warm = indexRepo(root);
console.log(`WARM files=${warm.files} ms=${Math.round(performance.now() - t1)}`);

// code_map: first 6 files in rank order
const mapOut = codeMap(root, { token_budget: 1500 });
const mapFiles = mapOut
  .split('\n')
  .slice(1)
  .filter((l) => l && !l.startsWith('  ') && !l.startsWith('...'));
console.log('MAP_HEAD:', mapOut.split('\n')[0]);
console.log('MAP_TOP6:', mapFiles.slice(0, 6).join(' | '));

// generic-word code_find first hits (rank should surface hubs)
for (const q of ['args', 'token', 'handler', 'command']) {
  const first = codeFind(root, q, { top_k: 1 });
  console.log(`FIND ${q} ->`, first.split('\n')[0]);
}

// Q1-style same-file callers
const callers = traceCallers(openStore(join(root, '.codegraph', 'index.sqlite')), 'get_ranked_tags', 2);
console.log(
  'TRACE get_ranked_tags callers:',
  callers.length === 0 ? '(empty)' : callers.slice(0, 5).map((n) => `${n.depth} ${n.file} ${n.symbol ?? ''}`).join(' ; ')
);
