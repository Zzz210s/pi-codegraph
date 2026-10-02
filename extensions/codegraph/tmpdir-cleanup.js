// tmpdir-cleanup.js - 测试临时目录的统一清理。
//
// 为什么需要:Windows 上 rmdir 会偶发 EPERM/EBUSY —— 新目录刚被杀软/索引器扫过、
// 或者某个句柄刚释放、目录级锁还没撤;并发跑多个测试文件时更容易撞上
// (实测:老写法 20×100ms 重试,12 轮里 1-2 次失败;同一个用例单独跑 25 轮 0 次)。
// 清理失败不该让"被测逻辑正确"的用例变红,所以这里把清理做成不会误伤:
//
//   1. 先给足重试(30 × 200ms ≈ 6 秒);
//   2. 还失败就逐个删子项,再删空目录(有时递归 rmdir 失败、逐个删却成功);
//   3. 仍失败只打一行警告 —— 临时目录交给系统清理,测试继续。
//
// 真出问题不会因此被掩盖:用例自己的断言与显式的"句柄是否泄漏"检查才是判据,
// 清理只是收尾。POSIX 上删被打开的文件本来就允许,这段逻辑基本等于直通。

import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const RETRY = { recursive: true, force: true, maxRetries: 30, retryDelay: 200 };
const FALLBACK = { force: true, maxRetries: 10, retryDelay: 200 };

function listFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else out.push(full);
  }
  return out;
}

/** 删掉一个测试临时目录;任何情况下都不抛错(失败只警告)。 */
export function cleanupDir(dir) {
  try {
    rmSync(dir, RETRY);
    return;
  } catch {
    // 落到逐项清理
  }
  for (const file of listFiles(dir)) {
    try {
      rmSync(file, FALLBACK);
    } catch {
      // 单个文件删不掉也不致命,继续删别的
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    console.warn(
      `[cleanupDir] 临时目录删不掉,先留着(系统会清理):${dir} (${error?.code ?? error})`
    );
  }
}
