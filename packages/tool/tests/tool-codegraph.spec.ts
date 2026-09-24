import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import Codegraph, { CodegraphIndexerId, CodegraphNodeId, CodegraphStoreId } from '@huanlin/dsh-plugin-codegraph-service'
import type { CodegraphIndexReport, CodegraphNode, CodegraphRequest, CodegraphStoreProvider } from '@huanlin/dsh-plugin-codegraph-service'
import * as ToolCodegraph from '../src/index.ts'
import { callTitle, projectRoot } from '../src/index.ts'
import { declarationsOnly, groupByFile, mergeByHits, mergeRelations, queryTerms, scoreByHits, taskTerms } from '../src/compose.ts'
import { toAffected, toHop, toRelation, toSymbol } from '../src/projection.ts'
import { renderCodegraph } from '../src/render.ts'
import type { CodegraphToolValue } from '../src/schema.ts'
import { readSlice } from '../src/source.ts'

const roots: string[] = []
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-codegraph-'))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text)
  return root
}

function graphNode(overrides: Partial<CodegraphNode> = {}): CodegraphNode {
  return {
    id: CodegraphNodeId('fn:main'),
    kind: 'function',
    name: 'main',
    qualifiedName: 'main',
    filePath: 'app.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 3,
    startColumn: 0,
    endColumn: 0,
    isExported: true,
    isAsync: false,
    isStatic: false,
    isAbstract: false,
    decorators: [],
    typeParameters: [],
    updatedAt: 1,
    ...overrides,
  }
}

const LIMITS = { maxDocstringChars: 8, maxSignatureChars: 8 }

const stubInbox = (): Inbox => ({
  nextTurn: [],
  nextStep: [],
  clear: () => {},
  append: () => {},
  prepend: () => {},
  replace: () => false,
  remove: () => false,
  splice: () => [],
})

describe('model-facing projection', () => {
  it('drops graph-only fields and renames positions for the model', () => {
    const view = toSymbol(graphNode(), LIMITS)
    expect(view).toEqual({
      name: 'main', qualified_name: 'main', kind: 'function', path: 'app.ts',
      line: 1, end_line: 3, language: 'typescript', exported: true,
    })
  })

  it('marks a clipped signature and docstring rather than truncating silently', () => {
    const view = toSymbol(graphNode({ signature: '(a: string, b: number)', docstring: 'A very long note' }), LIMITS)
    expect(view.signature).toBe('(a: stri…')
    expect(view.docstring).toBe('A very l…')
  })

  it('carries the reaching edge on relations, affected nodes, and hops', () => {
    const edge = { source: CodegraphNodeId('a'), target: CodegraphNodeId('b'), kind: 'calls', line: 9 }
    expect(toRelation({ node: graphNode(), edge, siteCount: 3 }, LIMITS))
      .toMatchObject({ via: 'calls', site_line: 9, site_count: 3 })
    const placeless = { source: CodegraphNodeId('a'), target: CodegraphNodeId('b'), kind: 'contains' }
    expect(toRelation({ node: graphNode(), edge: placeless, siteCount: 1 }, LIMITS).site_line).toBeUndefined()
    expect(toAffected({ node: graphNode(), distance: 2, via: 'references' }, LIMITS))
      .toMatchObject({ distance: 2, via: 'references' })
    expect(toHop({ node: graphNode(), edge }, LIMITS)).toMatchObject({ via: 'calls', site_line: 9 })
    expect(toHop({ node: graphNode() }, LIMITS).via).toBeUndefined()
  })
})

describe('task decomposition and merging', () => {
  it('keeps identifier-shaped words whole and drops filler', () => {
    expect(taskTerms('how does the useUrlState hook sync with url_state', 10))
      .toEqual(['useUrlState', 'url_state', 'hook', 'sync'])
  })

  it('returns at most the requested number of terms, longest first', () => {
    expect(taskTerms('alpha bb gamma delta', 2)).toEqual(['alpha', 'gamma'])
  })

  it('ranks a declaration found by several terms above one found by a single term', () => {
    const shared = graphNode({ name: 'shared', filePath: 'a.ts', startLine: 1 })
    const once = graphNode({ name: 'once', filePath: 'b.ts', startLine: 5 })
    const merged = mergeByHits([[once, shared], [shared]], 10)
    expect(merged.map(entry => [entry.node.name, entry.hits])).toEqual([['shared', 2], ['once', 1]])
  })

  it('breaks an equal-hit tie by the best position any single search gave', () => {
    const early = graphNode({ name: 'early', filePath: 'a.ts', startLine: 1 })
    const late = graphNode({ name: 'late', filePath: 'b.ts', startLine: 2 })
    expect(mergeByHits([[early, late]], 10).map(entry => entry.node.name)).toEqual(['early', 'late'])
  })

  it('groups declarations by file and spans the lines they cover', () => {
    const groups = groupByFile([
      graphNode({ filePath: 'a.ts', startLine: 10, endLine: 12 }),
      graphNode({ filePath: 'a.ts', startLine: 2, endLine: 4 }),
      graphNode({ filePath: 'b.ts', startLine: 1, endLine: 1 }),
    ], 5)
    expect(groups[0]).toMatchObject({ path: 'a.ts', startLine: 2, endLine: 12 })
    expect(groups.map(group => group.path)).toEqual(['a.ts', 'b.ts'])
    expect(groupByFile([graphNode({ filePath: 'a.ts' }), graphNode({ filePath: 'b.ts' })], 1)).toHaveLength(1)
  })

  it('keeps each related declaration once and stops at the limit', () => {
    const edge = { source: CodegraphNodeId('a'), target: CodegraphNodeId('b'), kind: 'calls' }
    const one = { node: graphNode({ name: 'one', filePath: 'a.ts' }), edge, siteCount: 1 }
    const two = { node: graphNode({ name: 'two', filePath: 'b.ts' }), edge, siteCount: 1 }
    expect(mergeRelations([[one, one], [two]], 10).map(relation => relation.node.name)).toEqual(['one', 'two'])
    expect(mergeRelations([[one], [two]], 1).map(relation => relation.node.name)).toEqual(['one'])
  })

  it('keeps declarations and drops the structural nodes that merely name them', () => {
    const kept = declarationsOnly([
      graphNode({ kind: 'function', name: 'real' }),
      graphNode({ kind: 'import', name: 'real' }),
      graphNode({ kind: 'file', name: 'a.ts' }),
    ])
    expect(kept.map(entry => entry.kind)).toEqual(['function'])
  })
})

describe('source retrieval', () => {
  const caps = { maxLines: 3, maxChars: 100 }

  it('returns the requested line window', async () => {
    const ctx = new Context()
    context = ctx
    const root = await workspace({ 'a.ts': 'one\ntwo\nthree\nfour\n' })
    await ctx.plugin(LocalFileSystem, { cwd: root })
    expect(await readSlice(ctx, root, 'a.ts', 2, 3, caps)).toEqual({
      code: 'two\nthree', startLine: 2, truncated: false,
    })
  })

  it('clamps a range that runs past the file and reports line truncation', async () => {
    const ctx = new Context()
    context = ctx
    const root = await workspace({ 'a.ts': 'one\ntwo\nthree\nfour\nfive\n' })
    await ctx.plugin(LocalFileSystem, { cwd: root })
    expect(await readSlice(ctx, root, 'a.ts', 0, 99, caps)).toMatchObject({
      code: 'one\ntwo\nthree', startLine: 1, truncated: true,
    })
  })

  it('reports character truncation separately from line truncation', async () => {
    const ctx = new Context()
    context = ctx
    const root = await workspace({ 'a.ts': 'abcdefghij\n' })
    await ctx.plugin(LocalFileSystem, { cwd: root })
    expect(await readSlice(ctx, root, 'a.ts', 1, 1, { maxLines: 3, maxChars: 4 }))
      .toMatchObject({ code: 'abcd', truncated: true })
  })

  it('answers with no code when the file cannot be read', async () => {
    const ctx = new Context()
    context = ctx
    const root = await workspace()
    await ctx.plugin(LocalFileSystem, { cwd: root })
    expect(await readSlice(ctx, root, 'missing.ts', 1, 2, caps))
      .toEqual({ code: null, truncated: false })
  })

  it('forwards a caller signal to the filesystem seam', async () => {
    const ctx = new Context()
    context = ctx
    const root = await workspace({ 'a.ts': 'one\n' })
    await ctx.plugin(LocalFileSystem, { cwd: root })
    const controller = new AbortController()
    controller.abort()
    expect(await readSlice(ctx, root, 'a.ts', 1, 1, caps, controller.signal)).toMatchObject({ code: null })
  })
})

describe('result rendering', () => {
  const symbol = toSymbol(graphNode(), { maxDocstringChars: 100, maxSignatureChars: 100 })
  const local = toSymbol(graphNode({ name: 'inner', isExported: false, signature: 'a\nb' }),
    { maxDocstringChars: 100, maxSignatureChars: 100 })
  const relation = { ...symbol, via: 'calls', site_line: 4, site_count: 2 }
  const base = { project_path: '/repo' }

  it.each<[string, CodegraphToolValue, RegExp]>([
    ['an empty search', { ...base, operation: 'search', symbols: [], total: 0, truncated: false }, /No declaration matches/],
    ['a capped search', { ...base, operation: 'search', symbols: [symbol], total: 4, truncated: true }, /\(1 of 4 shown\)/],
    ['an uncapped search', { ...base, operation: 'search', symbols: [symbol], total: 1, truncated: false }, /\(1\)/],
    ['an unresolved node', { ...base, operation: 'node', symbol: null, incoming: [], outgoing: [], alternatives: [], code: null }, /No declaration matches/],
    ['unresolved callers', { ...base, operation: 'callers', symbol: null, relations: [], total: 0, truncated: false }, /No declaration matches/],
    ['callers with none recorded', { ...base, operation: 'callers', symbol, relations: [], total: 0, truncated: false }, /none in the index/],
    ['callees', { ...base, operation: 'callees', symbol, relations: [relation], total: 1, truncated: false }, /Called by main/],
    ['an unresolved impact', { ...base, operation: 'impact', symbol: null, affected: [], total: 0, truncated: false }, /No declaration matches/],
    ['an impact with no dependents', { ...base, operation: 'impact', symbol, affected: [], total: 0, truncated: false }, /Nothing in the index depends on main/],
    ['an unresolved trace', { ...base, operation: 'trace', from: null, to: symbol, paths: [] }, /No declaration matches/],
    ['a trace with no route', { ...base, operation: 'trace', from: symbol, to: local, paths: [] }, /dynamic dispatch/],
    ['an empty file list', { ...base, operation: 'files', files: [], total: 0, truncated: false }, /No indexed file matches/],
    ['an empty explore', { ...base, operation: 'explore', files: [], total: 0, truncated: false }, /No declaration matches/],
    ['an empty context', { ...base, operation: 'context', task: 'ship it', entry_points: [], related: [], files: [] }, /Nothing in the index matches "ship it"/],
  ])('renders %s', (_label, value, pattern) => {
    expect(renderCodegraph(value)).toMatch(pattern)
  })

  it('renders a node with alternatives, both edge directions, and its source', () => {
    const text = renderCodegraph({
      ...base,
      operation: 'node',
      symbol: { ...symbol, docstring: 'Does\nthings.' },
      incoming: [relation],
      outgoing: [{ ...relation, via: 'contains', site_line: 0 }],
      alternatives: [local],
      code: 'function main() {}',
    })
    expect(text).toContain('Also named this')
    expect(text).toContain('Reached by:')
    expect(text).toContain('Reaches:')
    expect(text).toContain('(local)')
    expect(text).toContain('function main() {}')
  })

  it('marks repeat call sites and singular counts', () => {
    const text = renderCodegraph({
      ...base,
      operation: 'callers',
      symbol,
      relations: [relation, { ...relation, name: 'once', site_count: 1 }],
      total: 2,
      truncated: false,
    })
    expect(text).toContain('×2')
    expect(text).toContain('at line 4')
    expect(text).not.toContain('×1')
  })

  it('renders hop counts and path steps in singular and plural', () => {
    expect(renderCodegraph({
      ...base, operation: 'impact', symbol,
      affected: [{ ...symbol, via: 'calls', distance: 1 }, { ...symbol, via: 'calls', distance: 2 }],
      total: 2, truncated: false,
    })).toMatch(/1 hop,.*\n.*2 hops,/s)
    const traced = renderCodegraph({
      ...base, operation: 'trace', from: symbol, to: local,
      paths: [[{ ...symbol }, { ...local, via: 'calls', site_line: 7 }]],
    })
    expect(traced).toContain('1 path from main to inner')
    expect(traced).toContain('[calls at line 7]')
  })

  it('renders index status, including an index that has never run', () => {
    expect(renderCodegraph({
      ...base, operation: 'status', indexed: true, file_count: 2, symbol_count: 5, edge_count: 3,
      format_version: 4, indexed_at: 0, languages: [{ language: 'typescript', file_count: 2 }],
    })).toContain('Languages: typescript 2.')
    expect(renderCodegraph({
      ...base, operation: 'status', indexed: true, file_count: 0, symbol_count: 0, edge_count: 0,
      format_version: 4, indexed_at: null, languages: [],
    })).toMatch(/Languages: none\.\nLast indexed: never\./)
  })

  it("points at the project's own root or an index build when the root has no index", () => {
    expect(renderCodegraph({ ...base, operation: 'status', indexed: false }))
      .toBe("No index for `/repo`. If `/repo` is a container directory holding the project, pass the project's own root as project_path and retry; otherwise run codegraph_index on it to build one.")
  })

  it('treats a status answer with no languages array the same as an empty one', () => {
    const text = renderCodegraph({
      ...base, operation: 'status', indexed: true, file_count: 0, symbol_count: 0, edge_count: 0,
      format_version: 4, indexed_at: null,
    })
    expect(text).toContain('Languages: none.')
  })

  it('says nothing extra about staleness when nothing is stale', () => {
    const text = renderCodegraph({
      ...base, operation: 'status', indexed: true, file_count: 1, symbol_count: 1, edge_count: 0,
      format_version: 4, indexed_at: 0, languages: [], stale_file_count: 0, stale_file_count_truncated: false,
    })
    expect(text).not.toContain('codegraph_index to refresh')
  })

  it('names codegraph_index when the index has drifted from disk', () => {
    const one = renderCodegraph({
      ...base, operation: 'status', indexed: true, file_count: 1, symbol_count: 1, edge_count: 0,
      format_version: 4, indexed_at: 0, languages: [], stale_file_count: 1, stale_file_count_truncated: false,
    })
    expect(one).toContain('1 indexed file changed on disk or went missing since indexing. Call codegraph_index to refresh.')

    const many = renderCodegraph({
      ...base, operation: 'status', indexed: true, file_count: 3, symbol_count: 1, edge_count: 0,
      format_version: 4, indexed_at: 0, languages: [], stale_file_count: 3, stale_file_count_truncated: false,
    })
    expect(many).toContain('3 indexed files changed on disk or went missing since indexing.')

    const capped = renderCodegraph({
      ...base, operation: 'status', indexed: true, file_count: 1, symbol_count: 1, edge_count: 0,
      format_version: 4, indexed_at: 0, languages: [], stale_file_count: 1, stale_file_count_truncated: true,
    })
    expect(capped).toContain('at least 1 indexed files changed on disk or went missing since indexing.')
  })

  it('renders an index report in plain-fact style, distinguishing genuine gaps from likely-external noise', () => {
    const text = renderCodegraph({
      ...base, operation: 'index', files_indexed: 12, files_skipped: 1, symbol_count: 40,
      edge_count: 30, unresolved_count: 5, unresolved_likely_internal_count: 2,
      languages: [{ language: 'typescript', file_count: 12 }],
    })
    expect(text).toContain('Indexed /repo:')
    expect(text).toContain('12 files indexed, 1 skipped.')
    expect(text).toContain('40 symbols, 30 relationships.')
    expect(text).toContain('2 of 5 unresolved call sites look like genuine gaps')
    expect(text).toContain('Languages: typescript 12.')
  })

  it('reports every call site resolved when none are left unresolved', () => {
    const text = renderCodegraph({
      ...base, operation: 'index', files_indexed: 0, files_skipped: 0, symbol_count: 0,
      edge_count: 0, unresolved_count: 0, unresolved_likely_internal_count: 0, languages: [],
    })
    expect(text).toContain('Every call site resolved.')
    expect(text).toContain('Languages: none.')
  })

  it('renders explored and contextual files, including unreadable ones', () => {
    expect(renderCodegraph({
      ...base, operation: 'explore', total: 2, truncated: true,
      files: [
        { path: 'a.ts', symbols: [symbol], code: 'code', code_start_line: 1, truncated: true },
        { path: 'b.ts', symbols: [], code: null, truncated: false },
      ],
    })).toMatch(/source truncated[\s\S]*source unavailable for b\.ts/)
    expect(renderCodegraph({
      ...base, operation: 'context', task: 'ship', entry_points: [symbol], related: [relation],
      files: [{ path: 'a.ts', symbols: [], code: 'x', truncated: false }],
    })).toContain('Related:')
  })

  it('renders a single indexed file listing', () => {
    expect(renderCodegraph({
      ...base, operation: 'files', total: 1, truncated: false,
      files: [{ path: 'a.ts', language: 'typescript', size: 10, symbol_count: 2 }],
    })).toContain('a.ts  typescript  2 symbols')
  })
})

describe('call labelling and workspace resolution', () => {
  it('labels a call by whichever subject the operation takes', () => {
    expect(callTitle({ operation: 'callers', symbol: 'main' })).toBe('codegraph callers main')
    expect(callTitle({ operation: 'search', query: 'main' })).toBe('codegraph search main')
    expect(callTitle({ operation: 'context', task: 'ship it' })).toBe('codegraph context ship it')
    expect(callTitle({ operation: 'trace', from: 'a', to: 'b' })).toBe('codegraph trace a → b')
    expect(callTitle({ operation: 'trace', from: 'a' })).toBe('codegraph trace a → ?')
    expect(callTitle({ operation: 'files', pattern: '*.ts' })).toBe('codegraph files *.ts')
    expect(callTitle({ operation: 'files', path: 'src' })).toBe('codegraph files src')
    expect(callTitle({ operation: 'status' })).toBe('codegraph status')
  })

  it('prefers an explicit project path over the session workspace', () => {
    const exec = { agent: { session: { header: { cwd: '/session' } } } } as never
    expect(projectRoot({ operation: 'status', project_path: '/explicit' }, exec)).toBe('/explicit')
    expect(projectRoot({ operation: 'status', project_path: '   ' }, exec)).toBe('/session')
    expect(projectRoot({ operation: 'status' }, exec)).toBe('/session')
  })

  it('refuses to guess a workspace when neither is available', () => {
    expect(() => projectRoot({ operation: 'status' }, {} as never))
      .toThrow(/requires a session workspace or an explicit project_path/)
  })
})

describe('the tool plugin', () => {
  /** A store that records the request it received and answers with a minimal valid result. */
  const relation = {
    node: graphNode({ name: 'caller', filePath: 'caller.ts' }),
    edge: { source: CodegraphNodeId('a'), target: CodegraphNodeId('fn:main'), kind: 'calls', line: 4 },
    siteCount: 2,
  }
  const answers: Record<string, unknown> = {
    search: { kind: 'search', nodes: [graphNode()], total: 1, truncated: false },
    node: {
      kind: 'node', node: graphNode(), incoming: [relation], outgoing: [relation],
      alternatives: [graphNode({ name: 'main', filePath: 'other.ts' })],
    },
    callers: { kind: 'callers', subject: graphNode(), relations: [relation], total: 1, truncated: false },
    callees: { kind: 'callees', subject: graphNode(), relations: [relation], total: 1, truncated: false },
    impact: {
      kind: 'impact', subject: graphNode(), total: 1, truncated: false,
      entries: [{ node: graphNode({ name: 'dependent' }), distance: 1, via: 'calls' }],
    },
    trace: {
      kind: 'trace', from: graphNode(), to: graphNode({ name: 'far' }),
      paths: [[{ node: graphNode() }, { node: graphNode({ name: 'far' }), edge: relation.edge }]],
    },
    files: {
      kind: 'files', total: 1, truncated: false,
      files: [{ path: 'app.ts', language: 'typescript', size: 10, nodeCount: 2, modifiedAt: 1, indexedAt: 2 }],
    },
    status: {
      kind: 'status', projectRoot: '/repo', fileCount: 1, nodeCount: 1, edgeCount: 0,
      languages: [{ language: 'typescript', fileCount: 1 }], formatVersion: 4, indexedAt: null,
      staleFileCount: 1, staleFileCountTruncated: false,
    },
  }
  const seen: CodegraphRequest[] = []
  const indexed: string[] = []
  const indexReport: CodegraphIndexReport = {
    projectRoot: '/repo', filesIndexed: 2, filesSkipped: 1, nodeCount: 5, edgeCount: 3,
    unresolvedCount: 1, unresolvedLikelyInternalCount: 1, languages: [{ language: 'typescript', fileCount: 2 }],
  }

  async function mount(root: string, config?: Record<string, unknown>): Promise<Context> {
    seen.length = 0
    indexed.length = 0
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(Codegraph)
    const store: CodegraphStoreProvider = {
      id: CodegraphStoreId('stub'),
      indexes: () => Promise.resolve(true),
      query: ((request: CodegraphRequest) => {
        seen.push(request)
        if (request.operation === 'search') {
          // The stub echoes the queried term into a node of its own, plus a 'shared' declaration
          // every term also finds: a test searching several words can then see which sub-queries
          // ran, and a declaration both words find must merge ahead of the single-word ones.
          return Promise.resolve({
            kind: 'search',
            nodes: [
              graphNode({ id: `fn:${request.query}`, name: request.query, qualifiedName: request.query }),
              graphNode({ id: 'fn:shared', name: 'shared', qualifiedName: 'shared', filePath: 'shared.ts' }),
            ],
            total: 2,
            truncated: false,
          })
        }
        return Promise.resolve(answers[request.operation])
      }) as CodegraphStoreProvider['query'],
    }
    ctx.codegraph.registerStore(store)
    ctx.codegraph.registerIndexer({
      id: CodegraphIndexerId('stub-indexer'),
      canIndex: () => Promise.resolve(true),
      index: (projectRoot) => {
        indexed.push(projectRoot)
        return Promise.resolve({ ...indexReport, projectRoot })
      },
    })
    await ctx.plugin(ToolCodegraph, config)
    return ctx
  }

  function agent(ctx: Context, cwd: string): Agent {
    const scope = ctx.plugin(() => {})
    const id = SessionId('codegraph-unit')
    const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd, isSeeded: false })
    const value: Agent = {
      id, options: {}, session,
      inbox: stubInbox(),
      status: 'idle', ctx: scope.ctx,
      followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(value)
    return value
  }

  async function call(ctx: Context, owner: Agent, args: Record<string, unknown>, id = 'unit') {
    return ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(id),
      name: 'codegraph',
      arguments: args,
      agent: owner,
    })
  }

  async function callIndex(ctx: Context, owner: Agent | undefined, args: Record<string, unknown>, id = 'index') {
    return ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(id),
      name: 'codegraph_index',
      arguments: args,
      ...owner === undefined ? {} : { agent: owner },
    })
  }

  it('contributes its prompt section and schema', async () => {
    const root = await workspace()
    const ctx = await mount(root)
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('codegraph')
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('codegraph_index')
    const text = (await ctx.systemPrompt.assemble()).sections.map(section => section.text).join('\n')
    // The section is the imperative reading-path rule: codegraph before bash introspection, the
    // index as source of truth, and grep as the literal-text fallback.
    expect(text).toContain('Use the codegraph tool — not bash — to answer questions about the structure of existing code')
    expect(text).toContain("call codegraph first")
    expect(text).toContain("Never assume a symbol's properties, method signatures, or existence — the index is the source of truth")
    expect(text).toContain("do not pass a subdirectory of the session workspace as project_path")
    expect(text).toContain("call codegraph_index with the root of the project you mean — its repository root, not a subdirectory of it — and then retry")
    expect(text).toContain('fall back to the grep tool for literal text')
  })

  it('states the preference in both tool descriptions', async () => {
    const root = await workspace()
    const ctx = await mount(root)
    const descriptions = Object.fromEntries(ctx.tools.schemas().map(schema => [schema.name, schema.description]))
    expect(descriptions.codegraph).toContain('First source for questions about code structure')
    expect(descriptions.codegraph).toContain('call this before running bash (sed, cat, head, tail, grep, find)')
    expect(descriptions.codegraph).toContain('before writing a script to introspect code')
    expect(descriptions.codegraph).toContain("Omit project_path to query this session's workspace, whose index covers its subdirectories")
    expect(descriptions.codegraph).toContain('if the path you pass is not indexed on its own, the answer still comes, from the nearest indexed ancestor, and the result names it in resolution_note')
    expect(descriptions.codegraph).toContain('call codegraph_index with the root of the project you mean — its repository root, not a subdirectory of it — then retry')
    expect(descriptions.codegraph_index).toContain('before falling back to grep or to an introspection script')
    expect(descriptions.codegraph_index).toContain("not a container directory that merely contains the project, and not a subdirectory of an already-indexed project")
  })

  it('rejects "index" as an operation on the query tool', async () => {
    const root = await workspace()
    const ctx = await mount(root)
    const owner = agent(ctx, root)
    const result = await call(ctx, owner, { operation: 'index' })
    expect(result.isError).toBe(true)
  })

  it('runs the dedicated index tool against the resolved project root', async () => {
    const root = await workspace()
    const ctx = await mount(root)
    const owner = agent(ctx, root)
    const result = await callIndex(ctx, owner, {})
    expect(result.isError).toBe(false)
    expect(indexed).toEqual([root])
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('Indexed')
    expect(text).toContain('2 files indexed, 1 skipped')
  })

  it('lets the index tool target an explicit project outside any session', async () => {
    const root = await workspace()
    const ctx = await mount(root)
    const result = await callIndex(ctx, undefined, { project_path: '/elsewhere' }, 'explicit')
    expect(result.isError).toBe(false)
    expect(indexed).toEqual(['/elsewhere'])
  })

  it('carries its own timeout budget, distinct from the query tool', async () => {
    const root = await workspace()
    const ctx = await mount(root, { timeoutMs: 5000, indexTimeoutMs: 600_000 })
    expect(ctx.tools.get('codegraph')?.timeoutMs).toBe(5000)
    expect(ctx.tools.get('codegraph_index')?.timeoutMs).toBe(600_000)
  })

  it('runs every operation and passes the resolved bounds down', async () => {
    const root = await workspace({ 'app.ts': 'function main() {}\n' })
    const ctx = await mount(root)
    const owner = agent(ctx, root)
    for (const args of [
      { operation: 'search', query: 'main', kind: 'function', language: 'typescript' },
      { operation: 'node', symbol: 'main', include_code: true },
      { operation: 'callers', symbol: 'main' },
      { operation: 'callees', symbol: 'main' },
      { operation: 'impact', symbol: 'main' },
      { operation: 'trace', from: 'main', to: 'main' },
      { operation: 'files', path: 'src', pattern: '*.ts' },
      { operation: 'status' },
      { operation: 'explore', query: 'main' },
      { operation: 'context', task: 'how does main work' },
    ]) {
      const result = await call(ctx, owner, args, args.operation)
      expect(result.isError, `${args.operation} failed`).toBe(false)
    }
    expect(seen.some(request => request.operation === 'search' && request.kind === 'function')).toBe(true)
  })

  it('omits source for node unless the model asks for it', async () => {
    const root = await workspace({ 'app.ts': 'function main() {}\n' })
    const ctx = await mount(root)
    const owner = agent(ctx, root)
    const plain = await call(ctx, owner, { operation: 'node', symbol: 'main' }, 'plain')
    expect(plain.content.map(block => block.type === 'text' ? block.text : '').join(''))
      .not.toContain('function main() {}')
  })

  it('clamps a model-supplied limit and depth into the configured range', async () => {
    const root = await workspace()
    const ctx = await mount(root, { defaultLimit: 7, maxLimit: 9, defaultDepth: 2, maxDepth: 3 })
    const owner = agent(ctx, root)
    await call(ctx, owner, { operation: 'search', query: 'main' }, 'default')
    await call(ctx, owner, { operation: 'search', query: 'main', limit: 500 }, 'over')
    await call(ctx, owner, { operation: 'search', query: 'main', limit: 0 }, 'under')
    await call(ctx, owner, { operation: 'impact', symbol: 'main', depth: 99 }, 'depth')
    const limits = seen.filter(request => request.operation === 'search').map(request => request.limit)
    expect(limits).toEqual([7, 9, 1])
    expect(seen.find(request => request.operation === 'impact')?.depth).toBe(3)
  })

  it('searches each word of a multi-word query and merges the answers by hits', async () => {
    const root = await workspace()
    const ctx = await mount(root)
    const owner = agent(ctx, root)
    const result = await call(ctx, owner, { operation: 'search', query: 'alpha beta' })
    expect(result.isError).toBe(false)
    // One sub-query per word, each word intact — the old code sent the whole string as one
    // substring, which is what "EmptyOperationProvider EmptyPermissionProvider" never matched.
    expect(seen.filter(request => request.operation === 'search').map(request => request.query))
      .toEqual(['alpha', 'beta'])
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
    // 'shared' is found by both sub-queries, so it leads; the single-word declarations follow in
    // the order their searches returned them.
    expect(text.indexOf('shared')).toBeLessThan(text.indexOf('alpha'))
    expect(text.indexOf('alpha')).toBeLessThan(text.indexOf('beta'))
  })

  it('passes kind, language, and path to every sub-query of a multi-word search', async () => {
    const root = await workspace()
    const ctx = await mount(root)
    const owner = agent(ctx, root)
    await call(ctx, owner, { operation: 'search', query: 'alpha beta', path: 'web/modules', kind: 'function', language: 'php' })
    const subQueries = seen.filter(request => request.operation === 'search')
    expect(subQueries).toHaveLength(2)
    for (const request of subQueries) {
      expect(request).toMatchObject({ path: 'web/modules', kind: 'function', language: 'php' })
    }
  })

  it('keeps a single-word search on its one-store-call shape', async () => {
    const root = await workspace()
    const ctx = await mount(root)
    const owner = agent(ctx, root)
    await call(ctx, owner, { operation: 'search', query: 'alpha' })
    expect(seen.filter(request => request.operation === 'search')).toHaveLength(1)
    expect(seen.filter(request => request.operation === 'search')[0]).toMatchObject({ query: 'alpha' })
  })

  it('explore treats a multi-word query as a list of identifiers', async () => {
    // The stub's echoed nodes keep the default app.ts location, so both identifiers land in one
    // file group; the shared node the stub adds for every term lands in its own.
    const root = await workspace({ 'app.ts': 'function alpha() {}\nfunction beta() {}\n' })
    const ctx = await mount(root)
    const owner = agent(ctx, root)
    const result = await call(ctx, owner, { operation: 'explore', query: 'alpha beta' })
    expect(result.isError).toBe(false)
    expect(seen.filter(request => request.operation === 'search').map(request => request.query)).toEqual(['alpha', 'beta'])
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('function alpha() {}')
    expect(text).toContain('function beta() {}')
  })



  it.each([
    ['node', { operation: 'node' }, /requires a non-empty "symbol"/],
    ['search', { operation: 'search' }, /requires a non-empty "query"/],
    ['search with a blank query', { operation: 'search', query: '  ' }, /requires a non-empty "query"/],
    ['trace', { operation: 'trace', from: 'a' }, /requires a non-empty "to"/],
    ['context', { operation: 'context' }, /requires a non-empty "task"/],
  ])('rejects %s without its required argument', async (_label, args, pattern) => {
    const root = await workspace()
    const ctx = await mount(root)
    const owner = agent(ctx, root)
    const result = await call(ctx, owner, args)
    expect(result.isError).toBe(true)
    expect(result.content.map(block => block.type === 'text' ? block.text : '').join('')).toMatch(pattern)
  })

  it('labels the pending card from the call arguments', async () => {
    const root = await workspace()
    const ctx = await mount(root)
    const args = { operation: 'callers', symbol: 'main' }
    expect(ctx.tools.get('codegraph')?.presentCall?.(args)).toEqual({
      card: 'generic', title: 'codegraph callers main', kind: 'search', rawInput: args,
    })
  })

  it('labels the pending index card, with and without an explicit project', async () => {
    const root = await workspace()
    const ctx = await mount(root)
    expect(ctx.tools.get('codegraph_index')?.presentCall?.({})).toEqual({
      card: 'generic', title: 'codegraph_index', kind: 'search', rawInput: {},
    })
    const args = { project_path: '/elsewhere' }
    expect(ctx.tools.get('codegraph_index')?.presentCall?.(args)).toEqual({
      card: 'generic', title: 'codegraph_index /elsewhere', kind: 'search', rawInput: args,
    })
  })

  it('fails a call made outside any session workspace', async () => {
    const root = await workspace()
    const ctx = await mount(root)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('no-agent'),
      name: 'codegraph',
      arguments: { operation: 'status' },
    })
    expect(result.isError).toBe(true)
  })

  it.each([
    ['maxSourceFiles', { maxSourceFiles: 0 }],
    ['timeoutMs', { timeoutMs: 0 }],
    ['indexTimeoutMs', { indexTimeoutMs: 0 }],
  ])('fails loading when %s is out of range', async (field, config) => {
    const root = await workspace()
    await expect(mount(root, config)).rejects.toThrow(new RegExp(field))
  })
})

describe('status against a root no store claims', () => {
  async function mountWithoutStore(root: string): Promise<Context> {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(Codegraph)
    await ctx.plugin(ToolCodegraph)
    return ctx
  }

  function owner(ctx: Context, cwd: string): Agent {
    const scope = ctx.plugin(() => {})
    const id = SessionId('codegraph-unindexed')
    const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd, isSeeded: false })
    const value: Agent = {
      id, options: {}, session,
      inbox: stubInbox(),
      status: 'idle', ctx: scope.ctx,
      followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(value)
    return value
  }

  it('answers indexed:false rather than failing when nothing claims the root', async () => {
    const root = await workspace()
    const ctx = await mountWithoutStore(root)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('unindexed-status'),
      name: 'codegraph',
      arguments: { operation: 'status' },
      agent: owner(ctx, root),
    })
    expect(result.isError).toBe(false)
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toBe(`No index for \`${root}\`. If \`${root}\` is a container directory holding the project, pass the project's own root as project_path and retry; otherwise run codegraph_index on it to build one.`)
  })
})

describe('remaining display and parsing paths', () => {
  it('counts a repeated task word once, keeping its first spelling', () => {
    expect(taskTerms('Cache cache caching', 5)).toEqual(['caching', 'Cache'])
  })

  it('splits an explicit query on whitespace and separators, keeping every word', () => {
    // A query is a deliberate list of identifiers: unlike taskTerms, short and common words
    // survive, so a model that asked for one gets one searched.
    expect(queryTerms('add fix', 5)).toEqual(['add', 'fix'])
    expect(queryTerms('A, B;  C', 5)).toEqual(['A', 'B', 'C'])
  })

  it('splits a member-written query into its parts, like the CLI', () => {
    // "Class::member" (or Class.member) is the model's notation; searching it as one opaque
    // string finds nothing, so it is searched as its parts — the same way the codegraph CLI's
    // query treats delimiters.
    expect(queryTerms('Group::hasPermission', 5)).toEqual(['Group', 'hasPermission'])
    expect(queryTerms('Group.hasPermission', 5)).toEqual(['Group', 'hasPermission'])
    expect(queryTerms('Group#hasPermission', 5)).toEqual(['Group', 'hasPermission'])
    // A mixed query splits on both whitespace and delimiters.
    expect(queryTerms('GroupType hasPlugin Group::id', 5)).toEqual(['GroupType', 'hasPlugin', 'Group', 'id'])
  })

  it('keeps a single delimited word a single query when it carries no delimiter', () => {
    expect(queryTerms('parse', 5)).toEqual(['parse'])
  })

  it('drops a repeated query word in another casing, keeping the first spelling', () => {
    expect(queryTerms('GroupType grouptype GROUPTYPE', 5)).toEqual(['GroupType'])
  })

  it('caps an over-long query at the budget, in written order', () => {
    expect(queryTerms('a b c d e', 2)).toEqual(['a', 'b'])
  })

  it('scores a declaration found by several words ahead of single-word ones', () => {
    const both = graphNode({ id: 'fn:both', name: 'both', qualifiedName: 'both' })
    const first = graphNode({ id: 'fn:first', name: 'first', qualifiedName: 'first' })
    const second = graphNode({ id: 'fn:second', name: 'second', qualifiedName: 'second' })
    const scored = scoreByHits([[both, first], [both, second]])
    expect(scored.map(entry => entry.node.name)).toEqual(['both', 'first', 'second'])
    expect(scored[0]!.hits).toBe(2)
    expect(mergeByHits([[both, first], [both, second]], 2).map(entry => entry.node.name)).toEqual(['both', 'first'])
  })

  it('renders a traced hop whose edge site the indexer never recorded', () => {
    const symbol = toSymbol(graphNode(), { maxDocstringChars: 100, maxSignatureChars: 100 })
    const text = renderCodegraph({
      project_path: '/repo',
      operation: 'trace',
      from: symbol,
      to: symbol,
      paths: [[{ ...symbol }, { ...symbol, via: 'contains' }]],
    })
    expect(text).toContain('[contains]')
    expect(text).not.toContain('at line')
  })
})

describe('answers a store returns when nothing resolves', () => {
  /** A store whose every operation reports "no such symbol" rather than failing. */
  const EMPTY: Record<string, unknown> = {
    search: { kind: 'search', nodes: [graphNode({ filePath: 'gone.ts' })], total: 1, truncated: false },
    node: { kind: 'node', node: null, incoming: [], outgoing: [], alternatives: [] },
    callers: { kind: 'callers', subject: null, relations: [], total: 0, truncated: false },
    callees: { kind: 'callees', subject: null, relations: [], total: 0, truncated: false },
    impact: { kind: 'impact', subject: null, entries: [], total: 0, truncated: false },
    trace: { kind: 'trace', from: graphNode(), to: null, paths: [] },
    files: { kind: 'files', files: [], total: 0, truncated: false },
  }

  async function mountEmpty(root: string): Promise<Context> {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(Codegraph)
    ctx.codegraph.registerStore({
      id: CodegraphStoreId('empty'),
      indexes: () => Promise.resolve(true),
      query: ((request: CodegraphRequest) =>
        Promise.resolve(EMPTY[request.operation])) as CodegraphStoreProvider['query'],
    })
    await ctx.plugin(ToolCodegraph)
    return ctx
  }

  function owner(ctx: Context, cwd: string): Agent {
    const scope = ctx.plugin(() => {})
    const id = SessionId('codegraph-empty')
    const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd, isSeeded: false })
    const value: Agent = {
      id, options: {}, session,
      inbox: stubInbox(),
      status: 'idle', ctx: scope.ctx,
      followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(value)
    return value
  }

  it.each([
    ['node', { operation: 'node', symbol: 'gone', include_code: true }],
    ['callers', { operation: 'callers', symbol: 'gone' }],
    ['callees', { operation: 'callees', symbol: 'gone' }],
    ['impact', { operation: 'impact', symbol: 'gone' }],
    ['trace', { operation: 'trace', from: 'main', to: 'gone' }],
  ])('reports %s against an unresolved symbol as a successful answer', async (label, args) => {
    const root = await workspace()
    const ctx = await mountEmpty(root)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`empty-${label}`),
      name: 'codegraph',
      arguments: args,
      agent: owner(ctx, root),
    })
    expect(result.isError).toBe(false)
  })

  it('runs the filtered operations with no filters supplied', async () => {
    const root = await workspace()
    const ctx = await mountEmpty(root)
    const agentValue = owner(ctx, root)
    for (const args of [{ operation: 'search', query: 'gone' }, { operation: 'files' }]) {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(`bare-${args.operation}`),
        name: 'codegraph',
        arguments: args,
        agent: agentValue,
      })
      expect(result.isError).toBe(false)
    }
  })

  it('explores a file the index names but the workspace no longer holds', async () => {
    const root = await workspace()
    const ctx = await mountEmpty(root)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('explore-missing'),
      name: 'codegraph',
      arguments: { operation: 'explore', query: 'gone' },
      agent: owner(ctx, root),
    })
    expect(result.isError).toBe(false)
    expect(result.content.map(block => block.type === 'text' ? block.text : '').join(''))
      .toContain('source unavailable for gone.ts')
  })

  it('points an empty search at the retry that finds the name', async () => {
    const root = await workspace()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(Codegraph)
    ctx.codegraph.registerStore({
      id: CodegraphStoreId('no-search'),
      indexes: () => Promise.resolve(true),
      query: (() =>
        Promise.resolve({ kind: 'search', nodes: [], total: 0, truncated: false })) as CodegraphStoreProvider['query'],
    })
    await ctx.plugin(ToolCodegraph)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('empty-search-guidance'),
      name: 'codegraph',
      arguments: { operation: 'search', query: 'EmptyOperationProvider' },
      agent: owner(ctx, root),
    })
    expect(result.isError).toBe(false)
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toMatch(/No declaration matches "EmptyOperationProvider" in .*\./)
    expect(text).toContain('The index stores declarations only')
  })

  it('points an unresolved Class::member node at the search retry', async () => {
    const root = await workspace()
    const ctx = await mountEmpty(root)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('empty-member-node'),
      name: 'codegraph',
      arguments: { operation: 'node', symbol: 'Group::hasPermission' },
      agent: owner(ctx, root),
    })
    expect(result.isError).toBe(false)
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toMatch(/No declaration matches "Group::hasPermission" in .*\./)
    expect(text).toContain('Run search "Group::hasPermission" to list the closest names')
  })
})

describe('the last shapes a trace answer can take', () => {
  it('renders several routes in the plural', () => {
    const symbol = toSymbol(graphNode(), { maxDocstringChars: 100, maxSignatureChars: 100 })
    const hop = { ...symbol, via: 'calls', site_line: 2 }
    expect(renderCodegraph({
      project_path: '/repo', operation: 'trace', from: symbol, to: symbol,
      paths: [[{ ...symbol }, hop], [{ ...symbol }, hop]],
    })).toContain('2 paths from main to main')
  })

  it('reports a trace whose origin is the unresolved end', async () => {
    const root = await workspace()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(Codegraph)
    ctx.codegraph.registerStore({
      id: CodegraphStoreId('no-origin'),
      indexes: () => Promise.resolve(true),
      query: (() =>
        Promise.resolve({ kind: 'trace', from: null, to: graphNode(), paths: [] })) as CodegraphStoreProvider['query'],
    })
    await ctx.plugin(ToolCodegraph)
    const scope = ctx.plugin(() => {})
    const id = SessionId('codegraph-no-origin')
    const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: root, isSeeded: false })
    const value: Agent = {
      id, options: {}, session,
      inbox: stubInbox(),
      status: 'idle', ctx: scope.ctx,
      followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(value)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('trace-no-origin'),
      name: 'codegraph',
      arguments: { operation: 'trace', from: 'gone', to: 'main' },
      agent: value,
    })
    expect(result.isError).toBe(false)
    expect(result.content.map(block => block.type === 'text' ? block.text : '').join(''))
      .toContain('No declaration matches')
  })
})

describe('rendering permutations of an otherwise identical answer', () => {
  const symbol = toSymbol(graphNode(), { maxDocstringChars: 100, maxSignatureChars: 100 })
  const relation = { ...symbol, via: 'calls', site_line: 4, site_count: 2 }
  const base = { project_path: '/repo' }

  it('omits the sections a node answer has nothing for', () => {
    const text = renderCodegraph({
      ...base, operation: 'node', symbol, incoming: [], outgoing: [], alternatives: [], code: null,
    })
    expect(text).not.toContain('Also named this')
    expect(text).not.toContain('Reached by:')
    expect(text).not.toContain('Reaches:')
    expect(text).not.toContain('```')
  })

  it('omits the related section when a task matched no neighbours', () => {
    const text = renderCodegraph({
      ...base, operation: 'context', task: 'ship', entry_points: [symbol], related: [], files: [],
    })
    expect(text).not.toContain('Related:')
  })

  it('renders explored source that carries no start line', () => {
    const text = renderCodegraph({
      ...base, operation: 'explore', total: 1, truncated: false,
      files: [{ path: 'a.ts', symbols: [symbol], code: 'x', truncated: false }],
    })
    expect(text).toContain('  a.ts:')
    expect(text).not.toContain('source truncated')
  })

  it('renders callers whose sites the index placed and counted differently', () => {
    const text = renderCodegraph({
      ...base, operation: 'callers', symbol,
      relations: [{ ...relation, site_count: 1 }],
      total: 1, truncated: false,
    })
    expect(text).toContain('at line 4')
    expect(text).not.toContain('×')
  })

  it('renders a caller the index could not place', () => {
    const text = renderCodegraph({
      ...base, operation: 'callers', symbol,
      relations: [{ ...symbol, via: 'calls', site_count: 1 }],
      total: 1, truncated: false,
    })
    expect(text).not.toContain('at line')
  })

  it('marks truncated source in a task context too', () => {
    const text = renderCodegraph({
      ...base, operation: 'context', task: 'ship', entry_points: [symbol], related: [],
      files: [{ path: 'a.ts', symbols: [], code: 'x', truncated: true }],
    })
    expect(text).toContain('(source truncated)')
  })
})

// The failure this exists to prevent: a model that points the tool at a SUBDIRECTORY of an
// indexed project used to get an error whose advice repeated the exact call it had just made,
// and then abandoned the tool for the rest of the session. Every test below calls through the
// full tool surface (schema validation, seam, render) with a store that claims one explicit root.
describe('subdirectory resolution', () => {
  const seen: CodegraphRequest[] = []

  async function mount(root: string, claimed: readonly string[]): Promise<Context> {
    seen.length = 0
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(Codegraph)
    const store: CodegraphStoreProvider = {
      id: CodegraphStoreId('stub'),
      indexes: projectRoot => Promise.resolve(claimed.includes(projectRoot)),
      query: ((request: CodegraphRequest) => {
        seen.push(request)
        const answer = request.operation === 'status'
          ? {
              kind: 'status', projectRoot: request.projectRoot, fileCount: 1, nodeCount: 1, edgeCount: 0,
              languages: [{ language: 'typescript', fileCount: 1 }], formatVersion: 4, indexedAt: null,
              staleFileCount: 0, staleFileCountTruncated: false,
            }
          : request.operation === 'search'
            ? { kind: 'search', nodes: [graphNode()], total: 1, truncated: false }
            : request.operation === 'files'
              ? { kind: 'files', total: 0, truncated: false, files: [] }
              : request.operation === 'callers' || request.operation === 'callees'
                ? { kind: request.operation, subject: null, relations: [], total: 0, truncated: false }
                : request.operation === 'impact'
                  ? { kind: 'impact', subject: null, entries: [], total: 0, truncated: false }
                  : request.operation === 'trace'
                    ? { kind: 'trace', from: null, to: null, paths: [] }
                    : { kind: 'node', node: graphNode(), incoming: [], outgoing: [], alternatives: [] }
        return Promise.resolve(answer)
      }) as CodegraphStoreProvider['query'],
    }
    ctx.codegraph.registerStore(store)
    await ctx.plugin(ToolCodegraph)
    return ctx
  }

  function agent(ctx: Context, cwd: string): Agent {
    const scope = ctx.plugin(() => {})
    const id = SessionId('codegraph-subdir')
    const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd, isSeeded: false })
    const value: Agent = {
      id, options: {}, session,
      inbox: stubInbox(),
      status: 'idle', ctx: scope.ctx,
      followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(value)
    return value
  }

  async function call(ctx: Context, owner: Agent, args: Record<string, unknown>, id = 'unit'): Promise<ToolExecutionResult> {
    return ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(id),
      name: 'codegraph',
      arguments: args,
      agent: owner,
    })
  }

  const textOf = (result: Awaited<ReturnType<typeof call>>) =>
    result.content.map(block => block.type === 'text' ? block.text : '').join('')

  it('answers a subdirectory query from the nearest indexed ancestor, says so, and reads source from that root', async () => {
    const root = await workspace({ 'app.ts': 'function main() {\n  return 1\n}\n' })
    const ctx = await mount(root, [root])
    const owner = agent(ctx, root)
    const result = await call(ctx, owner, {
      operation: 'node', symbol: 'main', include_code: true, project_path: join(root, 'sub'),
    })
    expect(result.isError).toBe(false)
    const text = textOf(result)
    expect(text).toMatch(
      new RegExp(`^Note: ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/sub is not indexed on its own, so this answer comes from the nearest indexed ancestor, ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`),
    )
    // A source read resolved against the subdirectory the caller named would have come back
    // "source unavailable for app.ts": the read must run against the index root instead.
    expect(text).toContain('function main() {')
    expect(text).not.toContain('source unavailable')
    expect(seen.at(-1)).toMatchObject({ operation: 'node', projectRoot: root })
  })

  it('keeps an exact-root index ahead of the ancestor index', async () => {
    const root = await workspace()
    const sub = join(root, 'sub')
    const ctx = await mount(root, [root, sub])
    const owner = agent(ctx, root)
    await call(ctx, owner, { operation: 'node', symbol: 'main', project_path: sub })
    expect(seen.at(-1)).toMatchObject({ projectRoot: sub })
    expect(textOf(await call(ctx, owner, { operation: 'node', symbol: 'main', project_path: sub }))).not.toContain('Note:')
    await call(ctx, owner, { operation: 'node', symbol: 'main', project_path: root })
    expect(seen.at(-1)).toMatchObject({ projectRoot: root })
  })

  it('re-anchors path and pattern filters to the index root when routing to an ancestor', async () => {
    const root = await workspace()
    const ctx = await mount(root, [root])
    const owner = agent(ctx, root)
    await call(ctx, owner, { operation: 'search', query: 'main', path: 'src', project_path: join(root, 'sub') })
    await call(ctx, owner, { operation: 'files', path: 'src', pattern: 'p/*.ts', project_path: join(root, 'sub', 'deep') })
    expect(seen[0]).toMatchObject({ operation: 'search', projectRoot: root, path: 'sub/src' })
    expect(seen[1]).toMatchObject({ operation: 'files', projectRoot: root, path: 'sub/deep/src', pattern: 'sub/deep/p/*.ts' })
  })

  it('reports status from the nearest indexed ancestor for an unindexed subdirectory', async () => {
    const root = await workspace()
    const ctx = await mount(root, [root])
    const owner = agent(ctx, root)
    const result = await call(ctx, owner, { operation: 'status', project_path: join(root, 'sub') })
    expect(result.isError).toBe(false)
    const text = textOf(result)
    expect(text).toContain('is not indexed on its own')
    expect(text).toContain(`Index for ${root} (format version 4)`)
  })

  it('keeps indexed:false when no ancestor is indexed', async () => {
    const root = await workspace()
    const ctx = await mount(root, [join('/elsewhere', 'x')])
    const owner = agent(ctx, root)
    const result = await call(ctx, owner, { operation: 'status' })
    expect(textOf(result)).toBe(
      `No index for \`${root}\`. If \`${root}\` is a container directory holding the project, pass the project's own root as project_path and retry; otherwise run codegraph_index on it to build one.`,
    )
  })

  it('fails loud on every other operation when no ancestor is indexed', async () => {
    const root = await workspace()
    const ctx = await mount(root, [join('/elsewhere', 'x')])
    const owner = agent(ctx, root)
    const result = await call(ctx, owner, { operation: 'search', query: 'main', project_path: join(root, 'sub') })
    expect(result.isError).toBe(true)
    const text = textOf(result)
    expect(text).toContain('no code-graph store indexes')
    expect(text).toContain('or any ancestor directory')
    expect(text).toContain('Build one with codegraph_index')
  })

  it('carries the resolution note on the remaining operations too', async () => {
    const root = await workspace({ 'app.ts': 'function main() {\n  return 1\n}\n' })
    const ctx = await mount(root, [root])
    const owner = agent(ctx, root)
    const calls: Record<string, Record<string, unknown>> = {
      callers: { operation: 'callers', symbol: 'main', project_path: join(root, 'sub') },
      callees: { operation: 'callees', symbol: 'main', project_path: join(root, 'sub') },
      impact: { operation: 'impact', symbol: 'main', project_path: join(root, 'sub') },
      trace: { operation: 'trace', from: 'main', to: 'other', project_path: join(root, 'sub') },
      explore: { operation: 'explore', query: 'main', project_path: join(root, 'sub') },
      context: { operation: 'context', task: 'fix main', project_path: join(root, 'sub') },
    }
    for (const [operation, args] of Object.entries(calls)) {
      const result = await call(ctx, owner, args, `sub-${operation}`)
      const text = textOf(result)
      expect(result.isError, operation).toBe(false)
      expect(text, operation).toContain('is not indexed on its own')
      expect(text, operation).toContain(`nearest indexed ancestor, ${root}`)
    }
  })
})
