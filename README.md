# pi-codegraph

[pi coding agent](https://github.com/earendil-works/pi-coding-agent) 的本地代码检索扩展:tree-sitter 提取符号与调用边 + SQLite 存图,注册 `code_find` / `code_trace` / `code_impact` / `code_map` 四个工具与 `/reindex`、`/code doctor` 命令。零模型、零网络,全部本地计算。

## 目录

- [背景](#背景)
- [安装](#安装)
- [使用](#使用)
- [配置](#配置)
- [架构](#架构)
- [开发](#开发)

## 背景

agent 在陌生仓库里定位代码,通常要靠多轮 grep + 逐个读文件,轮次多、上下文浪费大。codegraph 用一次索引把整个仓库的符号表和调用图装进 SQLite,后续:

- 知道(或猜)符号名 -> 一次 `code_find` 直达定义行
- 查调用链 -> `code_trace`(callers/callees)替代多轮 grep
- 评估改动影响面 -> `code_impact` 给出 blast radius
- 陌生仓库摸结构 -> `code_map` 出 PageRank 排序的整仓地图

实测(冷索引):aider 151 文件 952ms、hono 355 文件 2.2s、cobra 36 文件 0.4s。

## 安装

依赖:Node >= 24(扩展加载与单测依赖原生 TS 类型剥离),pi 已安装。原生模块(tree-sitter 系列、better-sqlite3)需要本机编译工具链。

```bash
git clone https://github.com/Zzz210s/pi-codegraph.git ~/pi-codegraph
bash ~/pi-codegraph/setup.sh
```

重启 pi(或在 pi 内执行 /reload)后生效。

## 使用

在 pi 会话里:

- `code_find` — 按符号名(精确/前缀/子串)找定义,返回 `file:line kind name signature`,枢纽文件优先
- `code_trace` — 查"谁调用 X"/"X 调用了什么"(direction=callers/callees)
- `code_impact` — 改动影响面:受影响的文件、符号、测试(blast radius)
- `code_map` — 整仓地图:文件按 PageRank 中心度排序,附关键符号签名
- `/reindex <仓库根>` — 建索引(冷索引很快,151 文件约 1s)
- `/code doctor` — 环境与索引体检(依赖、索引库状态)

首次在某个仓库使用时先跑 `/reindex <仓库根>`。索引库存在仓库本地 `.codegraph/`(建议加入项目 .gitignore)。

支持语言:Python / TypeScript / TSX / Go / Java。

## 配置

无需配置。已知边界:

- 泛化词(如 `run`)的 `code_find` 只保证枢纽优先,不保证语义理想
- monkeypatch / 属性引用不产生调用边
- Go / Java 的目录级导入不解析到具体文件(callee_file 可能为 null)
- hot-path 缓存未做(当前规模查询 <10ms,可接受)

## 架构

单一职责模块,全部文件 <= 200 行,纯逻辑与副作用分离:

- `index.ts` — 扩展入口:注册工具与命令
- `parse*.ts` — 各语言 tree-sitter 解析(符号/调用提取),`parse.ts` 统一分发
- `indexer.ts` / `graph.ts` / `edges.ts` — 建图:解析产物 -> 符号表 + 调用边
- `pagerank.ts` — 中心度排序(code_find / code_map 的枢纽优先依据)
- `store.ts` / `store-io.ts` — SQLite 存取与迁移校验
- `find.ts` / `trace.ts` / `blast.ts` / `map.ts` — 四个工具的核心查询逻辑
- `tool-*.ts` — 工具的参数 schema 与输出格式化
- `doctor.ts` / `command-*.ts` — /code doctor 与 /reindex 命令实现
- `*.test.js` — 19 个测试文件(node --test,共 80+ 用例)

## 开发

```bash
cd extensions/codegraph
npm install        # 含 dev 依赖
npm test           # node --test,全部用例
```

```bash
bash setup.sh --test   # 单测通过后部署到 ~/.pi/agent/extensions/codegraph/
```

修改后 `/reload` 即可热加载;索引过期跑 `/reindex`。索引库损坏时工具会返回"删除 .codegraph/ 后 /reindex"提示。

## License

MIT
