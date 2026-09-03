// doctor.ts - /code doctor report generation. Pure Node module: no pi
// runtime dependency. Every check appends one line to the report text;
// dependency loading is injectable so tests never touch real npm packages.
//
//   doctor(root, opts?)  -> multi-line report:
//     node version, dependency loadability, index presence/integrity/counts,
//     language distribution, staleness (disk vs index), .gitignore advice.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';

import { scanSourceFiles } from './indexer.ts';

export interface DoctorOpts {
  /** Dependency load attempt; default resolves against this module. */
  tryLoad?: (name: string) => unknown;
}

const DEPS = [
  'tree-sitter',
  'tree-sitter-python',
  'tree-sitter-typescript',
  'tree-sitter-go',
  'tree-sitter-java',
  'better-sqlite3',
];

// extension -> short language label, used for the distribution line
const LANG_LABEL: Record<string, string> = {
  '.py': 'py',
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.go': 'go',
  '.java': 'java',
};

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot);
}

export function doctor(root: string, opts: DoctorOpts = {}): string {
  const load =
    opts.tryLoad ??
    ((name: string) => {
      const require = createRequire(import.meta.url);
      return require(name);
    });

  const lines: string[] = [];

  // 1. node version (type stripping needs >= 22, 24 recommended)
  const major = Number(process.versions.node.split('.')[0]);
  lines.push(
    `node: ${process.version} ${major >= 22 ? 'OK (>=22)' : 'WARN: 期望 >=22'}`
  );

  // 2. dependencies loadable
  for (const dep of DEPS) {
    try {
      load(dep);
      lines.push(`依赖 ${dep}: OK`);
    } catch (e) {
      const msg = (e as Error).message.split('\n', 1)[0];
      lines.push(`依赖 ${dep}: FAIL (${msg}) -- 建议在扩展目录执行 npm install`);
    }
  }

  // 3. index db: presence, integrity, counts
  const dbPath = join(root, '.codegraph', 'index.sqlite');
  if (!existsSync(dbPath)) {
    lines.push(`索引: 不存在 -- 先运行 /reindex ${root}`);
  } else {
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        const check = db.pragma('quick_check', { simple: true });
        if (check !== 'ok') throw new Error(`quick_check: ${String(check)}`);

        const count = (sql: string) =>
          (db.prepare(sql).get() as { n: number }).n;
        const files = count('SELECT COUNT(*) n FROM files');
        const symbols = count('SELECT COUNT(*) n FROM symbols');
        const edges = count('SELECT COUNT(*) n FROM edges');

        const dist = new Map<string, number>();
        for (const row of db.prepare('SELECT path FROM files').all() as {
          path: string;
        }[]) {
          const label = LANG_LABEL[extensionOf(row.path)] ?? '其他';
          dist.set(label, (dist.get(label) ?? 0) + 1);
        }
        const distText = [...dist.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([k, v]) => `${k} ${v}`)
          .join(', ');

        lines.push(`索引: 存在 | 文件 ${files} | 符号 ${symbols} | 边 ${edges}`);
        lines.push(`语言分布: ${distText}`);

        // 4. staleness: disk scan vs indexed count
        const disk = scanSourceFiles(root).length;
        if (disk === files) {
          lines.push(`陈旧度: 新鲜 (磁盘 ${disk} = 索引 ${files})`);
        } else {
          lines.push(
            `陈旧度: 待更新 (磁盘 ${disk} vs 索引 ${files}) -- 建议 /reindex ${root}`
          );
        }
      } finally {
        db.close();
      }
    } catch {
      lines.push(
        `索引: 损坏 -- 删除 ${join(root, '.codegraph')} 后运行 /reindex ${root}`
      );
    }
  }

  // 5. .gitignore advice (only meaningful inside a git repo)
  if (existsSync(join(root, '.git'))) {
    const giPath = join(root, '.gitignore');
    const covered = existsSync(giPath)
      ? readFileSync(giPath, 'utf8')
          .split('\n')
          .some((l) => l.trim().startsWith('.codegraph'))
      : false;
    lines.push(
      covered
        ? '.gitignore: 已含 .codegraph'
        : '.gitignore: 未含 .codegraph -- 建议添加,避免索引库入库'
    );
  }

  return lines.join('\n');
}
