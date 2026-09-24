/**
 * Model-facing `codegraph` tool family over `ctx.codegraph` and `ctx.fs`. The `codegraph` tool is
 * read-only, with ten operations: the eight the seam answers directly, plus `explore` and `context`,
 * which compose graph queries with source reads because a graph store returns positions and cannot
 * reach a workspace's bytes. A second tool, `codegraph_index`, builds or refreshes the graph on
 * explicit request; it is separate so it can carry its own, much larger timeout budget than a query
 * — `defineTool`'s `timeoutMs` is fixed per registration, not per call, so one operation cannot borrow
 * a bigger budget from within a shared tool.
 *
 * The tools own every default the seam refuses to guess — result limits, traversal depth, source
 * caps — so the seam's requests stay fully specified and a deployment can retune the model's answer
 * size without touching a store. They runtime-inject only `tools`, `codegraph`, `fs`, and
 * `systemPrompt`, and import no store.
 *
 * Namespace plugin (named exports, no default export).
 * @module @huanlin/dsh-plugin-codegraph-tool
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the `agent/pre-step` Events augmentation into this module's type context;
// the import emits nothing, so the package gains no runtime dependency.
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { UserMessage } from '@deepseek-ai/dsh-llm/message'
/**
 * Producer-owned source kind for the codegraph nudge. Session format v4 retired the
 * v3 `kind: 'plugin'` wrapper (the v4 row admission refuses any message whose source kind
 * is literally `'plugin'`), so the producer declares its own kind instead — the exact shape
 * the released v3→v4 migration assigns to this plugin (`plugin:<name>` for an unlisted
 * producer). The map key is the plugin id; the kind carries the `plugin:` namespace so the
 * attribution stays readable in the durable log.
 */
declare module '@deepseek-ai/dsh-llm/message' {
  // `ContextFormed` resolves in the augmented module's own scope.
  interface MessageSourceMap {
    codegraph: {
      readonly kind: 'plugin:codegraph'
    } & ContextFormed
  }
}
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { CodegraphError } from '@huanlin/dsh-plugin-codegraph-service'
import type { CodegraphNode, CodegraphRelation } from '@huanlin/dsh-plugin-codegraph-service'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { declarationsOnly, groupByFile, mergeByHits, mergeRelations, queryTerms, scoreByHits, taskTerms } from './compose.ts'
import type { FileGroup } from './compose.ts'
import { toAffected, toHop, toRelation, toSymbol } from './projection.ts'
import type { ProjectionLimits, SymbolView } from './projection.ts'
import { renderCodegraph } from './render.ts'
import { CODEGRAPH_INDEX_PARAMETERS, CODEGRAPH_OUTPUT_SCHEMA, CODEGRAPH_PARAMETERS } from './schema.ts'
import type { CodegraphIndexToolArgs, CodegraphToolArgs, CodegraphToolValue } from './schema.ts'
import { readSlice } from './source.ts'
import type { SourceLimits } from './source.ts'
import { bashCommand, introspectionVerbs, nudgeSummary, nudgeText, type IndexAvailability } from './nudge.ts'

export {
  CODEGRAPH_INDEX_PARAMETERS,
  CODEGRAPH_OPERATIONS,
  CODEGRAPH_OUTPUT_SCHEMA,
  CODEGRAPH_PARAMETERS,
  type CodegraphIndexToolArgs,
  type CodegraphToolArgs,
  type CodegraphToolOperation,
  type CodegraphToolValue,
  type CodegraphValueFor,
} from './schema.ts'
export { declarationsOnly, groupByFile, mergeByHits, mergeRelations, queryTerms, scoreByHits, taskTerms } from './compose.ts'
export {
  bashCommand,
  commandSegments,
  isCodeFileToken,
  isCodeIntrospectionCommand,
  hasSearchTarget,
  introspectionVerbs,
  nudgeSummary,
  nudgeText,
  segmentIntrospectionVerb,
  type IndexAvailability,
} from './nudge.ts'
export { toAffected, toHop, toRelation, toSymbol } from './projection.ts'
export { renderCodegraph } from './render.ts'
export { readSlice } from './source.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-codegraph'

/** Services required by this plugin. */
export const inject = ['tools', 'codegraph', 'fs', 'systemPrompt']

/** Default tool-call timeout budget (ms) for the query-side `codegraph` tool. */
export const DEFAULT_CODEGRAPH_TOOL_TIMEOUT_MS = 30_000

/** Default timeout budget (ms) for the `codegraph_index` tool. Indexing a monorepo is a different order of work than a query. */
export const DEFAULT_CODEGRAPH_INDEX_TIMEOUT_MS = 300_000

/**
 * The stable system-prompt rule, stated as the imperative the sibling tool sections use:
 * codegraph is the first attempt for code structure — ahead of bash and ahead of grep — with
 * `codegraph_index` as the no-index procedure and the grep tool as the literal-text fallback.
 */
export const CODEGRAPH_PROMPT_TEXT =
  'Use the codegraph tool — not bash — to answer questions about the structure of existing code. Before running a bash command that reads, searches, or locates code (sed, cat, head, tail, grep, find, rg), call codegraph first: `codegraph node <symbol>` returns one symbol\'s declaration with its code and call relations, without needing the file\'s path; `search <name>` finds declarations by name; `explore <query>` and `context <task>` give a task-sized overview with source. Write a symbol as the model writes it: a simple name (parse), a member as Class::member (Group::hasPermission), or the full qualified name a search returns — all three resolve. Name several identifiers space-separated in one search or explore call ("GroupType hasPlugin" finds both); a member written Class::member is searched as its parts. It matches real declarations, never occurrences in comments or strings, and returns far less text than an unbounded sed or grep. Never assume a symbol\'s properties, method signatures, or existence — the index is the source of truth; a missing result means the symbol is not indexed, so fall back to the grep tool for literal text before concluding it does not exist. bash is for running things — builds, tests, commands — and the read tool is for when you need a whole file. Omit project_path to query this session\'s workspace; its index covers the workspace\'s subdirectories, so do not pass a subdirectory of the session workspace as project_path (if you do, the answer still comes — from the nearest indexed ancestor, which the result names). If codegraph reports that no index exists anywhere up the tree from the root you gave, call codegraph_index with the root of the project you mean — its repository root, not a subdirectory of it — and then retry. Results reflect the last time the workspace was indexed.'

/** Plugin configuration: the defaults and caps the seam requires the consumer to own. */
export interface Config {
  /** Results returned when the model names no `limit` (default 20). */
  defaultLimit?: number
  /** Largest `limit` honored, whatever the model asks for (default 200). */
  maxLimit?: number
  /** Hops traversed by `impact` and `trace` when the model names no `depth` (default 2). */
  defaultDepth?: number
  /** Largest `depth` honored (default 6). */
  maxDepth?: number
  /** Distinct paths `trace` returns (default 5). */
  maxPaths?: number
  /** Files whose source `explore` and `context` return (default 5). */
  maxSourceFiles?: number
  /** Lines of source carried per file (default 200). */
  maxSourceLines?: number
  /** Characters of source carried per file (default 8000). */
  maxSourceChars?: number
  /** Characters of documentation carried per symbol (default 400). */
  maxDocstringChars?: number
  /** Characters of signature carried per symbol (default 200). */
  maxSignatureChars?: number
  /** Search terms extracted from a `context` task description (default 6). */
  maxContextTerms?: number
  /** Tool-call timeout budget in ms for the query-side `codegraph` tool (default 30000). */
  timeoutMs?: number
  /** Tool-call timeout budget in ms for the `codegraph_index` tool (default 300000). */
  indexTimeoutMs?: number
  /**
   * When true (default), a bash call that reads, searches, or locates code gets an advisory
   * reminder attached to its own result, pointing at codegraph as the first attempt. The
   * reminder fires at most a few times per agent run and never blocks or rewrites the call.
   */
  bashNudge?: boolean
}

export const Config: z<Config> = z.object({
  defaultLimit: z.number().default(20),
  maxLimit: z.number().default(200),
  defaultDepth: z.number().default(2),
  maxDepth: z.number().default(6),
  maxPaths: z.number().default(5),
  maxSourceFiles: z.number().default(5),
  maxSourceLines: z.number().default(200),
  maxSourceChars: z.number().default(8000),
  maxDocstringChars: z.number().default(400),
  maxSignatureChars: z.number().default(200),
  maxContextTerms: z.number().default(6),
  timeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_CODEGRAPH_TOOL_TIMEOUT_MS),
  indexTimeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_CODEGRAPH_INDEX_TIMEOUT_MS),
  bashNudge: z.boolean().default(true),
})

type ResolvedConfig = Required<Config>

/**
 * The project root a call runs against: the model's explicit `project_path`, else the calling
 * agent's session workspace. There is no process-cwd fallback — a graph query that silently answered
 * about a different checkout than the session is working in would be wrong in a way the model cannot
 * detect.
 * @param args - the validated tool arguments.
 * @param exec - the tool-execution context; only its optional `agent` is read.
 * @returns the absolute project root.
 */
export function projectRoot(args: CodegraphToolArgs, exec: ToolExecution): string {
  return resolvedProjectRoot(args.project_path, exec)
}

/**
 * Shared root-resolution logic behind {@link projectRoot} and the index tool's own argument shape.
 * @param explicit - the model's `project_path`, if given.
 * @param exec - the tool-execution context; only its optional `agent` is read.
 * @returns the absolute project root.
 */
function resolvedProjectRoot(explicit: string | undefined, exec: ToolExecution): string {
  if (explicit !== undefined && explicit.trim() !== '') return explicit
  const sessionCwd = exec.agent?.session.header.cwd
  if (sessionCwd === undefined) {
    throw new CodegraphError(
      'the codegraph tool requires a session workspace or an explicit project_path',
      'CODEGRAPH_WORKSPACE_REQUIRED',
    )
  }
  return sessionCwd
}

/** Read a required string argument, rejecting an absent or blank value. */
function required(args: CodegraphToolArgs, field: 'symbol' | 'query' | 'task' | 'from' | 'to'): string {
  const value = args[field]
  if (value === undefined || value.trim() === '') {
    throw new CodegraphError(
      `the codegraph "${args.operation}" operation requires a non-empty "${field}"`,
      'CODEGRAPH_INVALID_REQUEST',
    )
  }
  return value
}

/** Clamp a model-supplied bound into the configured range. */
function bounded(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(1, Math.trunc(value)))
}

/**
 * Largest number of sub-queries one multi-term call may issue. A query naming more identifiers than
 * this still gets an answer — the first eight words, in the order written — but the extra words
 * would only spend store round-trips on a tail the result limit would drop anyway.
 */
const MAX_QUERY_TERMS = 8

/**
 * Search a query the way the model means it: each whitespace- or comma-separated word is searched
 * on its own against the store, and the per-word answers merge into one ranked list, a declaration
 * found by several words ahead of one found by a single word.
 *
 * A single-word query short-circuits to the store's own answer untouched, so the one-word call shape
 * is byte-identical to the one it used to take; only multi-word queries gain the merge, which is what
 * lets `search "A B"` and `explore "A B"` name several symbols in one call instead of reading the
 * whole string as one substring.
 * @param ctx - the plugin context.
 * @param root - the project root the sub-queries run against.
 * @param query - the raw query text.
 * @param filters - the optional kind/language/path restrictions, passed to every sub-query.
 * @param limit - largest number of declarations the answer carries, per sub-query and after merging.
 * @param signal - aborts the sub-queries.
 * @returns the merged declarations with the total and truncation the answer should report.
 */
async function searchTerms(
  ctx: Context,
  root: string,
  query: string,
  filters: { kind?: string; language?: string; path?: string },
  limit: number,
  signal: AbortSignal | undefined,
): Promise<{ nodes: readonly CodegraphNode[]; total: number; truncated: boolean }> {
  const terms = queryTerms(query, MAX_QUERY_TERMS)
  const batches = await Promise.all(terms.map(term => ctx.codegraph.query({
    operation: 'search',
    projectRoot: root,
    query: term,
    ...filters,
    limit,
  }, signal)))
  if (terms.length === 1) {
    // terms.length === 1 proved the batch holds exactly one entry; the assertion only satisfies
    // noUncheckedIndexedAccess, no branch is implied.
    const only = batches[0]!
    return { nodes: only.nodes, total: only.total, truncated: only.truncated }
  }
  const scored = scoreByHits(batches.map(batch => batch.nodes))
  return {
    nodes: scored.slice(0, limit).map(entry => entry.node),
    total: scored.length,
    truncated: batches.some(batch => batch.truncated) || scored.length > limit,
  }
}

/**
 * Register the `codegraph` tool and its system-prompt guidance.
 * @param ctx - the plugin context (must inject `tools`, `codegraph`, `fs`, `systemPrompt`).
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  for (const field of [
    'defaultLimit', 'maxLimit', 'defaultDepth', 'maxDepth', 'maxPaths', 'maxSourceFiles',
    'maxSourceLines', 'maxSourceChars', 'maxDocstringChars', 'maxSignatureChars', 'maxContextTerms',
  ] as const) {
    assertPositiveInteger(field, resolved[field])
  }
  assertTimer('timeoutMs', resolved.timeoutMs)
  assertTimer('indexTimeoutMs', resolved.indexTimeoutMs)

  // Order 1510: one slot after dsh-system-prompt's TOOL_GREP section (order
  // 1500). The rule overrides the "Use the grep tool" imperative, so it must
  // follow that line in the assembled prompt; the former 111 sat far before
  // the tool cluster the model reads when choosing between search tools.
  ctx.systemPrompt.section({ name: 'tool:codegraph', order: 1510, text: CODEGRAPH_PROMPT_TEXT })

  ctx.tools.register(defineTool({
    name: 'codegraph',
    description:
      'First source for questions about code structure: call this before running bash (sed, cat, head, tail, grep, find) to read, search, or locate code, before writing a script to introspect code, and before writing code that depends on existing symbols, and prefer it over grep. Query a pre-built index of the workspace\'s declarations and their relationships: where a symbol is declared (its code with include_code), what calls it, what it calls, what a change to it can affect, and how one symbol reaches another. It matches declarations, not occurrences in comments or strings, and finds files whose path you do not know. search and explore take one or more identifiers in a single call, space-separated ("GroupType hasPlugin" finds both, merged), and a member written Class::member or Class.member is searched as its parts; node and its friends take one symbol — a simple name, Class::member (Group::hasPermission), or the full qualified name a search returns. Omit project_path to query this session\'s workspace, whose index covers its subdirectories — pass it only for a different project; if the path you pass is not indexed on its own, the answer still comes, from the nearest indexed ancestor, and the result names it in resolution_note. If it reports no index anywhere up the tree from the root you gave, call codegraph_index with the root of the project you mean — its repository root, not a subdirectory of it — then retry; use grep only as the fallback for literal text. Answers reflect the last time the workspace was indexed.',
    parameters: CODEGRAPH_PARAMETERS,
    output: {
      schema: CODEGRAPH_OUTPUT_SCHEMA,
      render: (args, value) => [{ type: 'text', text: renderCodegraph(value, renderSubject(args)) }],
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      return run(ctx, resolved, args, exec)
    },
    presentCall: args => ({
      card: 'generic' as const,
      title: callTitle(args),
      kind: 'search' as const,
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'codegraph_index',
    description:
      'Build or refresh the codegraph index for a workspace, so the codegraph tool can answer. Call it when codegraph reports that no index exists anywhere up the tree from the root you gave — before falling back to grep or to an introspection script — then retry codegraph. Index the project\'s own root: not a container directory that merely contains the project, and not a subdirectory of an already-indexed project (the codegraph tool answers subdirectory queries from the nearest indexed ancestor, so a nested index would only shadow it). Indexing a large workspace can take minutes, so this runs on its own timeout budget, separate from codegraph\'s query operations.',
    parameters: CODEGRAPH_INDEX_PARAMETERS,
    output: {
      schema: CODEGRAPH_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderCodegraph(value) }],
    },
    timeoutMs: resolved.indexTimeoutMs,
    async execute(args, exec) {
      return runIndex(ctx, args, exec)
    },
    presentCall: args => ({
      card: 'generic' as const,
      title: args.project_path === undefined ? 'codegraph_index' : `codegraph_index ${args.project_path}`,
      kind: 'search' as const,
      rawInput: args,
    }),
  }))

  if (resolved.bashNudge) installBashNudge(ctx)
}

/** One agent's in-flight bash-reading run: the call count and the index probe it triggered. */
interface NudgeRun {
  count: number
  root: string | undefined
  availability: IndexAvailability | undefined
}

/**
 * The `tools/post-execute` side of the codegraph-first rule: a bash call that reads, searches, or
 * locates code gets one advisory reminder attached to its own result, escalating at the configured
 * run counts and capped so a heavy bash-style session is never flooded. A codegraph call (or a new
 * user message, via `agent/pre-step`) resets the run, because the model has demonstrated the
 * behavior the reminder asks for.
 * @param ctx - the plugin context (must inject `tools` and `codegraph`).
 */
function installBashNudge(ctx: Context): void {
  const runs = new WeakMap<object, NudgeRun>()

  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const downstream = await next()
    const nudge = await nudgeForCall(ctx, exec, runs)
    if (nudge === undefined) return downstream
    return {
      ...downstream,
      additionalContexts: [nudge, ...(downstream.additionalContexts ?? [])],
    }
  })

  ctx.on('agent/pre-step', ({ agent, messages }, next) => {
    if (messages.some(message => message.source.kind === 'user')) runs.delete(agent)
    return next()
  })
}

/**
 * Decide whether one just-settled call carries a nudge, and build it: only `bash` calls whose
 * command reads code qualify; the run counter decides the firing (thresholds), and the index
 * probe decides the text. Codegraph calls reset the run instead of nudging.
 * @param ctx - the plugin context (must inject `codegraph`).
 * @param exec - the settled call.
 * @param runs - per-agent run state.
 * @returns the reminder message, or `undefined` when this call carries none.
 */
async function nudgeForCall(ctx: Context, exec: ToolExecution, runs: WeakMap<object, NudgeRun>): Promise<UserMessage | undefined> {
  const agent = exec.agent
  if (agent === undefined) return undefined
  if (exec.name === 'codegraph' || exec.name === 'codegraph_index') {
    runs.delete(agent)
    return undefined
  }
  if (exec.name !== 'bash') return undefined
  const command = bashCommand(exec.arguments)
  if (command === undefined) return undefined
  const verbs = introspectionVerbs(command)
  if (verbs.length === 0) return undefined

  let run = runs.get(agent)
  if (run === undefined) {
    run = { count: 0, root: sessionRoot(agent), availability: undefined }
    runs.set(agent, run)
  }
  run.count += 1
  if (!NUDGE_THRESHOLDS.includes(run.count)) return undefined
  if (run.availability === undefined && run.root !== undefined) {
    run.availability = await probeAvailability(ctx, run.root, exec.signal)
  }
  const availability = run.availability ?? 'unknown'
  const verbList = verbs.join(', ')
  return createUserMessage({
    content: [{ type: 'text', text: nudgeText(run.count, availability, verbList) }],
    source: {
      kind: 'plugin:codegraph',
      form: 'notice',
      summary: nudgeSummary(run.count, availability, verbList),
    },
  })
}

/** Run lengths at which the reminder fires; the run stops nudging past the last one. */
const NUDGE_THRESHOLDS = [1, 3, 5, 8]

/** The calling agent's session workspace — the root the index is probed at. */
function sessionRoot(agent: NonNullable<ToolExecution['agent']>): string | undefined {
  return agent.session.header.cwd
}

/** Whether the root has a codegraph index; probe failures degrade to `unknown`, never to a nudge veto. */
async function probeAvailability(ctx: Context, root: string, signal: AbortSignal): Promise<IndexAvailability> {
  try {
    return (await ctx.codegraph.available(root, signal)) ? 'available' : 'missing'
  } catch {
    return 'unknown'
  }
}

/**
 * The one-line label a pending call shows.
 * @param args - the validated tool arguments.
 * @returns the card title naming the operation and whichever subject the operation takes.
 */
export function callTitle(args: CodegraphToolArgs): string {
  const subject = args.symbol ?? args.query ?? args.task
    ?? (args.from === undefined ? undefined : `${args.from} → ${args.to ?? '?'}`)
    ?? args.pattern ?? args.path
  return subject === undefined ? `codegraph ${args.operation}` : `codegraph ${args.operation} ${subject}`
}

/**
 * The text the model asked for, for the operations whose empty answers can say what was asked:
 * the renderer uses it to turn "no match" into a retry that names the words the model should vary.
 * @param args - the validated tool arguments.
 * @returns the query, symbol, or endpoint text of the call, or `undefined` for operations that
 * take no subject.
 */
function renderSubject(args: CodegraphToolArgs): string | undefined {
  switch (args.operation) {
    case 'search':
    case 'explore':
      return args.query
    case 'node':
    case 'callers':
    case 'callees':
    case 'impact':
      return args.symbol
    case 'trace':
      return args.from === undefined ? undefined : `${args.from} → ${args.to ?? '?'}`
    default:
      return undefined
  }
}

/**
 * Build or refresh the on-disk index for one project. The dedicated tool this backs carries its own,
 * much larger timeout budget than a query — indexing a monorepo is a different order of work.
 * @param ctx - the plugin context.
 * @param args - the index tool's validated arguments.
 * @param exec - the tool-execution context.
 * @returns the index operation's canonical value.
 */
async function runIndex(
  ctx: Context,
  args: CodegraphIndexToolArgs,
  exec: ToolExecution,
): Promise<CodegraphToolValue> {
  const root = resolvedProjectRoot(args.project_path, exec)
  const report = await ctx.codegraph.index(root, exec.signal)
  return {
    operation: 'index',
    project_path: root,
    files_indexed: report.filesIndexed,
    files_skipped: report.filesSkipped,
    symbol_count: report.nodeCount,
    edge_count: report.edgeCount,
    unresolved_count: report.unresolvedCount,
    unresolved_likely_internal_count: report.unresolvedLikelyInternalCount,
    languages: report.languages.map(entry => ({ language: entry.language, file_count: entry.fileCount })),
  }
}

/**
 * The note a value carries when the requested root is not indexed on its own: it names both roots,
 * so a model that pointed at a subdirectory sees exactly which index answered instead of assuming
 * its own path was the index — and can re-aim follow-up calls at the named root.
 * @param requested - the root the call resolved to before the seam looked.
 * @param resolved - the root the seam's index actually lives at.
 * @returns the note text, or `undefined` when the call was served from the root it named.
 */
function resolutionNote(requested: string, resolved: string): string | undefined {
  if (requested === resolved) return undefined
  return `Note: ${requested} is not indexed on its own, so this answer comes from the nearest indexed ancestor, ${resolved}.`
}

/**
 * Answer one tool call.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration.
 * @param args - the validated tool arguments.
 * @param exec - the tool-execution context.
 * @returns the canonical value for the requested operation.
 */
async function run(
  ctx: Context,
  config: ResolvedConfig,
  args: CodegraphToolArgs,
  exec: ToolExecution,
): Promise<CodegraphToolValue> {
  // The root the call MEANT, before the seam resolves it: an explicit project_path, else the
  // session workspace. Every query below passes it UNRESOLVED, so the seam's own routing decides
  // the store, the index root, and the re-anchoring of any path/pattern filters — the seam is the
  // single owner of that logic, and this call never corrupts it by pre-resolving.
  const requested = projectRoot(args, exec)
  // The root the seam actually serves: the requested one when a store indexes it, else the
  // nearest indexed ancestor. This is what every SOURCE READ (node include_code, explore,
  // context) must run against — an index's file paths live relative to the root it was built
  // for, not the subdirectory a caller pointed at — and what the answer reports as project_path,
  // with the note below explaining the difference whenever the two diverge.
  const root = await ctx.codegraph.resolveRoot(requested, exec.signal)
  const note = resolutionNote(requested, root)
  const limit = bounded(args.limit, config.defaultLimit, config.maxLimit)
  const depth = bounded(args.depth, config.defaultDepth, config.maxDepth)
  const projection: ProjectionLimits = {
    maxDocstringChars: config.maxDocstringChars,
    maxSignatureChars: config.maxSignatureChars,
  }
  const source: SourceLimits = { maxLines: config.maxSourceLines, maxChars: config.maxSourceChars }
  const signal = exec.signal

  switch (args.operation) {
    case 'search': {
      const found = await searchTerms(ctx, requested, required(args, 'query'), {
        ...args.kind === undefined ? {} : { kind: args.kind },
        ...args.language === undefined ? {} : { language: args.language },
        ...args.path === undefined ? {} : { path: args.path },
      }, limit, signal)
      return {
        ...(note === undefined ? {} : { resolution_note: note }),
        operation: 'search',
        project_path: root,
        symbols: found.nodes.map(node => toSymbol(node, projection)),
        total: found.total,
        truncated: found.truncated,
      }
    }
    case 'node': {
      const result = await ctx.codegraph.query({
        operation: 'node',
        projectRoot: requested,
        symbol: required(args, 'symbol'),
        limit,
      }, signal)
      const symbol = result.node === null ? null : toSymbol(result.node, projection)
      const code = args.include_code === true && result.node !== null
        ? (await readSlice(ctx, root, result.node.filePath, result.node.startLine, result.node.endLine, source, signal)).code
        : null
      return {
        ...(note === undefined ? {} : { resolution_note: note }),
        operation: 'node',
        project_path: root,
        symbol,
        incoming: result.incoming.map(relation => toRelation(relation, projection)),
        outgoing: result.outgoing.map(relation => toRelation(relation, projection)),
        alternatives: result.alternatives.map(node => toSymbol(node, projection)),
        code,
      }
    }
    case 'callers':
    case 'callees': {
      const result = await ctx.codegraph.query({
        operation: args.operation,
        projectRoot: requested,
        symbol: required(args, 'symbol'),
        limit,
      }, signal)
      return {
        ...(note === undefined ? {} : { resolution_note: note }),
        operation: args.operation,
        project_path: root,
        symbol: result.subject === null ? null : toSymbol(result.subject, projection),
        relations: result.relations.map(relation => toRelation(relation, projection)),
        total: result.total,
        truncated: result.truncated,
      }
    }
    case 'impact': {
      const result = await ctx.codegraph.query({
        operation: 'impact',
        projectRoot: requested,
        symbol: required(args, 'symbol'),
        depth,
        limit,
      }, signal)
      return {
        ...(note === undefined ? {} : { resolution_note: note }),
        operation: 'impact',
        project_path: root,
        symbol: result.subject === null ? null : toSymbol(result.subject, projection),
        affected: result.entries.map(entry => toAffected(entry, projection)),
        total: result.total,
        truncated: result.truncated,
      }
    }
    case 'trace': {
      const result = await ctx.codegraph.query({
        operation: 'trace',
        projectRoot: requested,
        from: required(args, 'from'),
        to: required(args, 'to'),
        maxDepth: depth,
        maxPaths: config.maxPaths,
      }, signal)
      return {
        ...(note === undefined ? {} : { resolution_note: note }),
        operation: 'trace',
        project_path: root,
        from: result.from === null ? null : toSymbol(result.from, projection),
        to: result.to === null ? null : toSymbol(result.to, projection),
        paths: result.paths.map(path => path.map(hop => toHop(hop, projection))),
      }
    }
    case 'files': {
      const result = await ctx.codegraph.query({
        operation: 'files',
        projectRoot: requested,
        ...args.path === undefined ? {} : { path: args.path },
        ...args.pattern === undefined ? {} : { pattern: args.pattern },
        limit,
      }, signal)
      return {
        ...(note === undefined ? {} : { resolution_note: note }),
        operation: 'files',
        project_path: root,
        files: result.files.map(file => ({
          path: file.path,
          language: file.language,
          size: file.size,
          symbol_count: file.nodeCount,
        })),
        total: result.total,
        truncated: result.truncated,
      }
    }
    case 'status': {
      const available = await ctx.codegraph.available(requested, signal)
      if (!available) {
        return { operation: 'status', project_path: root, indexed: false }
      }
      const result = await ctx.codegraph.query({ operation: 'status', projectRoot: requested }, signal)
      return {
        ...(note === undefined ? {} : { resolution_note: note }),
        operation: 'status',
        project_path: root,
        indexed: true,
        file_count: result.fileCount,
        symbol_count: result.nodeCount,
        edge_count: result.edgeCount,
        format_version: result.formatVersion,
        indexed_at: result.indexedAt,
        languages: result.languages.map(entry => ({
          language: entry.language,
          file_count: entry.fileCount,
        })),
        stale_file_count: result.staleFileCount,
        stale_file_count_truncated: result.staleFileCountTruncated,
      }
    }
    case 'explore': {
      // The CLI's explore takes a list of identifiers, not a phrase: each word is a symbol the
      // caller wants source for, so the words are searched individually and merged — a single
      // substring match across the whole string finds nothing when the words name separate
      // declarations, which is the shape of every multi-identifier query.
      const found = await searchTerms(ctx, requested, required(args, 'query'), {}, limit, signal)
      const declarations = declarationsOnly(found.nodes)
      const groups = groupByFile(declarations, config.maxSourceFiles)
      return {
        ...(note === undefined ? {} : { resolution_note: note }),
        operation: 'explore',
        project_path: root,
        files: await Promise.all(groups.map(group => explored(ctx, root, group, projection, source, signal))),
        total: found.total,
        truncated: found.truncated || groups.length < countFiles(declarations),
      }
    }
    case 'context': {
      const task = required(args, 'task')
      const terms = taskTerms(task, config.maxContextTerms)
      const batches = await Promise.all(terms.map(async term => (await ctx.codegraph.query({
        operation: 'search',
        projectRoot: requested,
        query: term,
        limit,
      }, signal)).nodes))
      const ranked = mergeByHits(batches.map(declarationsOnly), limit).map(scored => scored.node)
      const related = await relatedTo(ctx, requested, ranked, config, signal)
      const groups = groupByFile(ranked, config.maxSourceFiles)
      return {
        ...(note === undefined ? {} : { resolution_note: note }),
        operation: 'context',
        project_path: root,
        task,
        entry_points: ranked.map(node => toSymbol(node, projection)),
        related: related.map(relation => toRelation(relation, projection)),
        files: await Promise.all(groups.map(group => explored(ctx, root, group, projection, source, signal))),
      }
    }
    /* v8 ignore next -- exhaustive over the parameter schema's closed operation enum; unreachable. */
    default:
      return assertNever(args.operation, 'tool-codegraph operation')
  }
}

/** How many distinct files a ranked result set spans. */
function countFiles(nodes: readonly CodegraphNode[]): number {
  return new Set(nodes.map(node => node.filePath)).size
}

/** Read one file group's source and pair it with the declarations that selected it. */
async function explored(
  ctx: Context,
  root: string,
  group: FileGroup,
  projection: ProjectionLimits,
  source: SourceLimits,
  signal?: AbortSignal,
): Promise<{
  path: string
  symbols: SymbolView[]
  code: string | null
  code_start_line?: number
  truncated: boolean
}> {
  const slice = await readSlice(ctx, root, group.path, group.startLine, group.endLine, source, signal)
  return {
    path: group.path,
    symbols: group.nodes.map(node => toSymbol(node, projection)),
    code: slice.code,
    ...slice.startLine === undefined ? {} : { code_start_line: slice.startLine },
    truncated: slice.truncated,
  }
}

/**
 * Callers and callees of the highest-ranked declarations a task matched.
 *
 * Only the top declarations are expanded: a task's context is the neighbourhood of what it is about,
 * and querying every match's relations would spend the result budget on the tail of the ranking.
 * @param ctx - the plugin context.
 * @param root - the project root.
 * @param ranked - the task's matched declarations, most relevant first.
 * @param config - the resolved plugin configuration.
 * @param signal - aborts the queries.
 * @returns the merged relations.
 */
async function relatedTo(
  ctx: Context,
  root: string,
  ranked: readonly CodegraphNode[],
  config: ResolvedConfig,
  signal?: AbortSignal,
): Promise<CodegraphRelation[]> {
  const seeds = ranked.slice(0, config.maxSourceFiles)
  const batches = await Promise.all(seeds.flatMap(node => (['callers', 'callees'] as const).map(
    async operation => (await ctx.codegraph.query({
      operation,
      projectRoot: root,
      symbol: node.qualifiedName,
      limit: config.defaultLimit,
    }, signal)).relations,
  )))
  return mergeRelations(batches, config.defaultLimit)
}

/** Reject a non-positive-integer config value at load, so misconfiguration fails loud. */
function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-codegraph: ${field} must be a positive integer`)
  }
}

/** Reject a timer value Node would clamp instead of scheduling as configured. */
function assertTimer(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-codegraph: ${field} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}
