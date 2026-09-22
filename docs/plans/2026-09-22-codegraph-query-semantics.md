# codegraph 查询语义对齐 CLI:多词查询、Class::member 解析、path 过滤、空结果自救（2026-09-22）

- 日期：2026-09-22
- 影响包：`service`（0.1.11 → 0.1.13）、`sqlite`（0.1.11 → 0.1.13）、`tool`（0.1.12 → 0.1.13）、`bundle`（0.1.12 → 0.1.13）；`tree-sitter` 无改动（0.1.12）
- 回滚基线：`main@<本次提交前>`（`git revert` 一次即可）
- 前置工作：同日早前的 `2026-09-22-codegraph-first-nudge.md`（0.1.12）解决了"agent 根本不调 codegraph"；本条解决"调了但查询语义和 CLI 不一致、空结果无出路"。

## 背景与诊断

guestwi.se 的最近一次会话（`session-acf5d3bd`，1.5GB 的 CLI v9 索引，202591 符号）里 27 次 `codegraph` 调用，
失败全部集中在两类入参，而 CLI 对同样的入参都有正常输出：

| 入参形态 | 例 | 结果 |
|---|---|---|
| 多词 `explore`/`search` | `explore "EmptyOperationProvider EmptyPermissionProvider"`（用户原话复现） | 全部 "No declaration matches"，0 命中 |
| `Class::member` 的 `node` | `node "GroupRelationshipTypeStorage::getRelationshipTypeId"`、`node "Group::hasPermission"` | 全部 "No declaration matches" |
| 单词 `search`、简单名 `node` | `search "hasPermissionInGroup"`、`node "getRelationshipTypeId"` | 正常 |

根因（store 与 CLI 的查询语义分叉，索引本身是好的——两个类就在库里）：

1. **store 把 query 当一个字符串**：`lower(name) LIKE '%q%' OR lower(qualified_name) LIKE '%q%' UNION nodes_fts MATCH '"q"*'`。
   整串 `EmptyOperationProvider EmptyPermissionProvider` 做子串/FTS 短语匹配，必然 0 命中；而 CLI 的
   `query`/`explore` 对每个词单独检索再合并（实测 `codegraph query "Group.hasPermission"`、
   `codegraph query "DefaultPluginManager::getDefinition"` 均能命中，且对成员分隔符也做切分）。
2. **符号解析只有精确层**：`node` 的 `Class::member` 与索引里存的限定名（v4 是
   `file::Class.member`、CLI v9 是 `Namespace\…::Class::method`）字面不同，任何一层精确匹配都不命中。
3. **`path` 参数被静默吞掉**：seam 的 `CodegraphSearchRequest` 没有这个字段，工具层收到了也不传，
   模型以为加了目录过滤，实际没有（会话里 `search "hasPlugin" path web/modules/contrib/group/src` 如此）。
4. **空结果没有出路**：旧文案只说"No declaration matches"，模型接下来该干什么全靠猜。

## 改动

设计原则：**查询语义的分叉修在 tool 层与 store 层，seam 契约保持"一个字符串"；索引格式与 schema 一字不改**
（v8/v9 照读；外部 CLI 的索引继续可用）。

1. **tool：多词/成员式 query 的 per-term 检索与合并**（`compose.ts`、`index.ts`）
   - `queryTerms`：按 空格/逗号/分号 + **成员分隔符（`::`、`.`、`#`，与 store 的解析同一套）** 切词，
     大小写去重（保首个拼写）、上限 8 词。单词且无分隔符 → 1 词 → **短路走旧单查路径，行为与改动前字节一致**。
   - `searchTerms`：每个词一次 store `search`（`kind`/`language`/`path`/`limit` 逐词传递），
     新增 `scoreByHits`/`mergeByHits`：按 `file:start:qualifiedName` 去重，按"命中词数 desc、原排序 asc"合并截断，
     `total`/`truncated` 语义对合并结果成立（`explore` 同样走这条，再进 declarationsOnly + groupByFile + 读源）。
2. **sqlite：成员分隔符回退层**（`sql.ts`、`queries.ts`）
   - `memberSuffixPatterns(symbol)`：把符号在**每处**分隔符切开，每个 `(owner, member)` 用**三种分隔符**重组，
     生成 `lower(qn) LIKE '%owner<joiner>member'` 的后缀模式（上限 8 处）。
   - `resolveSymbol` 的 `node/callers/callees/impact/trace` 五路符号解析加回退层：精确层（限定名精确 → 名精确 →
     名大小写）永远优先，回退层垫底，层内按 kind/导出/文件/行确定性排序；`node` 答里的 `alternatives` 展示歧义
     （如 `SubGroup::hasPermission` 与 `Group::hasPermission`）。
   - `search` 支持 `path`：`file_path LIKE '前缀/%'`，`_`/`%`/`\` 按 LIKE 转义（`escapeLike`），`_` 不当通配。
3. **service：seam 契约加 `path?`**（`types.ts`）：`CodegraphSearchRequest.path?: string`，
   在 SQL 里过滤而不是查后过滤（查后过滤会破坏 `total`/`truncated`/`limit` 语义）。
4. **空结果自救**（`render.ts`）：空答统一改成
   `No declaration matches "<subject>" in <root>。<按操作给下一步>`：
   - `search` → "索引只存声明，注释/字符串里的名字不会出现；换个写法，或用 grep 查字面文本"
   - `explore` → "每个词单独检索，这些词都没匹配到声明"
   - `node` → "先 `search "<symbol>"` 列最接近的名字，把其中一个传给 node"
   - `callers/callees/impact` → "先 `search` 再重试"
   - `trace` → "至少一个端点不是索引里的名字，分别 search 两个端点"
   - 工具描述、system prompt、nudge 文案同步补上：成员可以写 `Class::member`，search/explore 的词会被切分。
5. **测试**（全仓 619 passed / 3 skipped，此前基线 595/1）
   - tool 单测：`queryTerms`（切分/去重/上限/成员分隔符）、`scoreByHits`/`mergeByHits`；
     plugin 集成：多词 search 逐词子查 + 过滤透传、多词 explore 读两文件源码、空 search/`Class::member` node 的自救文案。
   - sqlite store：成员回退层（v4/v9 两种约定互解、精确层压过回退层、歧义进 `alternatives`、`Class::member`
     走通 callers/callees/impact、无匹配返回 null）、`search` 的 `path` 前缀与 `_` 转义。
   - **live 回归（永久、自选符号）**：`live-tool.spec.ts` 新增一例，从 `DSH_CODEGRAPH_LIVE_ROOT` 指向的索引里
     动态挑两个类名 + 一个方法（取其限定名最后两段拼 `Class::member`，与索引实际分隔符可以不同），
     验证多词 search/explore 与成员式 node 在**任意 CLI 版本的真实索引**（v4/v8/v9、任意仓库）上都能答。
     无索引环境自动 skip，不挡 CI。

## 验证

```sh
pnpm run typecheck && pnpm test          # 619 passed / 3 skipped
DSH_CODEGRAPH_LIVE_ROOT=/home/derek/src/guestwi.se pnpm vitest run packages/tool/tests/live-tool.spec.ts   # 2 passed
```

对 guestwi.se 会话失败入参的逐条重放（改后全部命中）：

- `explore "EmptyOperationProvider EmptyPermissionProvider"`（用户原话复现）→ 两个类 + 源码（改前 0 命中）
- `node "GroupRelationshipTypeStorage::getRelationshipTypeId"` → 精确定位 + 调用关系 + 源码（改前 "No declaration matches"）
- `node "Group::hasPermission"`、`node "DefaultPluginManager::getDefinition"`（后者确属查无此名：
  类只以 import 存在、方法在父类——CLI `node` 同样报 not found，行为对齐；CLI `query` 则返回候选，
  本插件 `search "DefaultPluginManager::getDefinition"` 现在也返回同样一組候选：类、`getDefinitions`、各 `getDefinition`）
- `search "hasPlugin" path web/modules/contrib/group/src` → path 真正生效（改前被忽略）
- 索引格式、schema 版本、CLI 互操作性均未变（v9 照读，202591 符号）。

## 生效方式

同 0.1.12：`cordis.patch.yml` 的 `patchReload: live` 只重建 profile context，**手动重启 `dsh web`（或新开会话）**
新文案与新查询语义才进 system prompt；已存在的会话用旧语义。
