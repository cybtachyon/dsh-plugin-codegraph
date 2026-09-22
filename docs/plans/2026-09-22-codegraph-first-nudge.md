# codegraph-first：提示词改写 + bash 读码的实时提醒（2026-09-22）

- 日期：2026-09-22
- 影响包：`tool`（0.1.11 → 0.1.12）、`bundle`（0.1.11 → 0.1.12）；service/sqlite/tree-sitter 无改动
- 回滚基线：`main@<本次提交前>`（`git revert` 一次即可）

## 背景与诊断

guestwi.se 会话（`session-1a2159a3`，430 步）里，agent 用 bash 读了 263/280 次代码
（sed 120、head/tail 85、grep 34、find 4），`codegraph` / `codegraph_index` 调用为 **0**，
尽管：

- 每次 model request 的 header 里都带着全部 31 个工具（含 `codegraph`、`codegraph_index`）；
- 每条 system message 都包含 `tool:codegraph` 段落（旧文案，order 1510）；
- 会话 cwd 下 27 小时前刚建过 1.5GB 的 `.codegraph/codegraph.db`（新鲜、可用）。

即**接线完全正确，是行为问题**：27B 模型无视了提示词中段那句陈述式的
"Code structure is read with codegraph, not with bash"。典型失败链：猜路径 →
`sed -n '/function access(/,…)p' …/EntityAccessControlHandler.php`（No such file or directory）
→ `find web/core -name "EntityAccessControlHandler.php"` → `read` 才拿到正确文件。

## 改动

1. **`CODEGRAPH_PROMPT_TEXT` 改为祈使句规则**（`packages/tool/src/index.ts`）：
   明确"先用 codegraph，再谈 bash"，点名 `codegraph node <symbol>` 等入口，保留
   "index 是唯一事实来源 / 查不到再 grep" 与 no-index 流程（container root → `project_path`；
   无索引 → `codegraph_index`）。
2. **`codegraph` 工具描述改写**：开头即"First source … before running bash (sed, cat, head,
   tail, grep, find) …"，让模型在选工具的那一刻看到规则。
3. **新增 `tools/post-execute` 提醒（`packages/tool/src/nudge.ts` + `index.ts`）**：
   对每个 agent 维护一次"运行"的 bash 读码计数，命令分类器（quote-aware 分段 +
   sed/cat/head/tail/grep/rg/`find -name`/`xargs` 动词表；php/phpunit/composer/git/
   ls 等一律不算）判定后，在第 1/3/5/8 次触发一条 advisory plugin context
   （`additionalContexts`，随该 bash 结果回给模型，**只提醒、不拦截、不改写**），
   文本按索引状态自适应：有索引 → 点名 codegraph；无索引 → 点名 `codegraph_index`；
   探测失败 → 中性措辞。任何 `codegraph` / `codegraph_index` 调用或新的用户消息
   （`agent/pre-step`）都会重置计数，所以提醒最多出现 4 次/任务，不会刷屏。
4. **新增配置项 `bashNudge`（默认 `true`）**：profile 补丁可按行 id `codegraph-tool`
   关掉提醒（`config: { bashNudge: false }`）。
5. **测试**：`packages/tool/tests/nudge.spec.ts`（29 例：分类器/文案单测 + 真实
   `Context` 上的 waterfall 集成——阈值、重置、索引自适应、disable、无 agent、
   无 command、顺序保证、无 cwd）；同步更新 `tool-codegraph.spec.ts` 里
   两处旧文案断言。

## 验证

```sh
pnpm run build && pnpm run test:coverage
# tool/src：100/100/100/100（index.ts + nudge.ts 全覆盖）
# 全仓 595 passed / 1 skipped（live-tool 需环境）；
# sqlite/tree-sitter 两处 branch 缺口为平台相关既有问题（Windows 错误码分支），main 上同样存在。
```

## 生效方式

profile 的 `patchReload: live` 只监听 `cordis.patch.yml` 变化并**重建 profile context**
（会断开当前会话），因此**手动重启 `dsh web` 服务**（或在新会话上生效）；
当前会话的 system prompt 在会话开始时已组装，重启后新会话才会看到新文案与新提醒。
