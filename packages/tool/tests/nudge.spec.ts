// The bash-introspection nudge: unit coverage for the command classifier and reminder text, plus
// Context-level coverage for the tools/post-execute waterfall (firing thresholds, resets, index
// adaptivity, and the bashNudge toggle).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import Codegraph, { CodegraphIndexerId, CodegraphNodeId, CodegraphStoreId } from '@huanlin/dsh-plugin-codegraph-service'
import type { CodegraphIndexReport, CodegraphNode, CodegraphStoreProvider } from '@huanlin/dsh-plugin-codegraph-service'
import * as ToolCodegraph from '../src/index.ts'
import {
  bashCommand,
  commandSegments,
  hasSearchTarget,
  introspectionVerbs,
  isCodeFileToken,
  isCodeIntrospectionCommand,
  nudgeSummary,
  nudgeText,
  segmentIntrospectionVerb,
} from '../src/nudge.ts'

describe('command segmentation', () => {
  it('splits on ; && || | and newlines', () => {
    expect(commandSegments('ls a; b && c | d || e\nf')).toEqual(['ls a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('keeps a quoted pipe or semicolon inside one segment', () => {
    expect(commandSegments('grep -i "kernel\\|Group" web/core/f.php')).toHaveLength(1)
    expect(commandSegments('echo "a; b | c"')).toHaveLength(1)
    expect(commandSegments("sed -n '/function access(/,/^  }/p' web/core/f.php | head -80")).toHaveLength(2)
  })

  it('drops empty segments', () => {
    expect(commandSegments('a; ; b ||')).toEqual(['a', 'b'])
  })
})

describe('argument classification', () => {
  it('accepts slash paths whose final segment carries an extension', () => {
    expect(isCodeFileToken('web/core/lib/Drupal/Foo.php')).toBe(true)
    expect(isCodeFileToken('src/App.ts')).toBe(true)
  })

  it('rejects bare filenames, directories, dotfiles, and sed script addresses', () => {
    expect(isCodeFileToken('foo.php')).toBe(false)
    expect(isCodeFileToken('web/core')).toBe(false)
    expect(isCodeFileToken('web/.env')).toBe(false)
    expect(isCodeFileToken('/function access(/,/^  }/p')).toBe(false)
  })

  it('treats a search as file-directed only with a recursive flag or a slash path', () => {
    expect(hasSearchTarget(['grep', '-n', 'foo'])).toBe(false)
    expect(hasSearchTarget(['grep', '-n', 'foo', 'web/core/'])).toBe(true)
    expect(hasSearchTarget(['grep', '-rn', 'foo'])).toBe(true)
    expect(hasSearchTarget(['rg', '--recursive', 'foo'])).toBe(true)
  })

  it('names the introspection verb a segment reads with', () => {
    expect(segmentIntrospectionVerb('sed -n \'1,100p\' web/modules/Foo.php')).toBe('sed')
    expect(segmentIntrospectionVerb('cat web/modules/Foo.module')).toBe('cat')
    expect(segmentIntrospectionVerb('head -80 src/app.ts')).toBe('head')
    expect(segmentIntrospectionVerb('tail -n 20 src/app.ts')).toBe('tail')
    expect(segmentIntrospectionVerb('grep -n "hook_entity_access" web/core/Entity.php')).toBe('grep')
    expect(segmentIntrospectionVerb('rg --type php "EntityAccess" web/modules/')).toBe('rg')
    expect(segmentIntrospectionVerb('find web/core -name "EntityAccessControlHandler.php"')).toBe('find')
    expect(segmentIntrospectionVerb('find web/core | head')).toBeUndefined()
    expect(segmentIntrospectionVerb('xargs grep -l "createForEntityInGroup"')).toBe('grep')
    expect(segmentIntrospectionVerb('xargs rm -f')).toBeUndefined()
  })

  it('does not name runners, builders, listings, or file mutations', () => {
    expect(segmentIntrospectionVerb('php -l src/App.php')).toBeUndefined()
    expect(segmentIntrospectionVerb('vendor/bin/phpunit --filter Foo')).toBeUndefined()
    expect(segmentIntrospectionVerb('composer install')).toBeUndefined()
    expect(segmentIntrospectionVerb('drush php:evaluate x')).toBeUndefined()
    expect(segmentIntrospectionVerb('git log --oneline')).toBeUndefined()
    expect(segmentIntrospectionVerb('ls -la web/modules/')).toBeUndefined()
    expect(segmentIntrospectionVerb('rm -rf build/ && mkdir build')).toBeUndefined()
    expect(segmentIntrospectionVerb('cd web/modules && cat App.php')).toBeUndefined()
    expect(segmentIntrospectionVerb('')).toBeUndefined()
  })

  it('flags whole commands by their segments', () => {
    const failedSed = 'sed -n \'/function access(/,/\\//\\// The checkAccess() call/Ip\' web/core/lib/Drupal/Core/Entity/Access/EntityAccessControlHandler.php | head -80'
    expect(isCodeIntrospectionCommand(failedSed)).toBe(true)
    expect(introspectionVerbs(failedSed)).toEqual(['sed'])
    expect(introspectionVerbs('find web/core -name "Foo.php" | xargs grep -l bar')).toEqual(['find', 'grep'])
    expect(isCodeIntrospectionCommand('git log | grep x')).toBe(false)
    expect(isCodeIntrospectionCommand('phpunit --filter X 2>&1 | tail -50')).toBe(false)
    expect(isCodeIntrospectionCommand('php -l a.php && composer dump-autoload')).toBe(false)
    expect(introspectionVerbs('php -l a.php')).toEqual([])
  })
})

describe('reminder text', () => {
  it('points at codegraph first on the first firing', () => {
    const text = nudgeText(1, 'available', 'sed')
    expect(text).toContain('call codegraph first')
    expect(text).toContain('codegraph node <symbol>')
    expect(text).toContain('sed')
  })

  it('quotes the run count on later firings', () => {
    expect(nudgeText(3, 'available', 'sed, grep')).toContain('3 times')
    expect(nudgeText(8, 'available', 'find')).toContain('8 times')
  })

  it('names codegraph_index when no index exists', () => {
    const text = nudgeText(1, 'missing', 'cat')
    expect(text).toContain('codegraph_index')
    expect(text).toContain('no codegraph index')
  })

  it('stays neutral when the index probe fails', () => {
    const text = nudgeText(5, 'unknown', 'grep')
    expect(text).toContain('codegraph_index')
    expect(text).toContain('codegraph node <symbol>')
  })

  it('bounds the notice summary to the context-form limit', () => {
    expect(nudgeSummary(3, 'available', 'sed, grep')).toBe('codegraph first · bash sed, grep × 3')
    expect(nudgeSummary(3, 'available', 'sed, grep').length).toBeLessThanOrEqual(120)
    expect(nudgeSummary(1, 'missing', 'cat')).toBe('codegraph index missing — build with codegraph_index')
  })
})

describe('bash argument extraction', () => {
  it('returns a usable command string', () => {
    expect(bashCommand({ command: 'cat a.php', description: 'x' })).toBe('cat a.php')
  })

  it('rejects missing, blank, non-string, and non-object arguments', () => {
    expect(bashCommand({})).toBeUndefined()
    expect(bashCommand({ command: '   ' })).toBeUndefined()
    expect(bashCommand({ command: 42 })).toBeUndefined()
    expect(bashCommand(null)).toBeUndefined()
    expect(bashCommand('cat a.php')).toBeUndefined()
  })
})

describe('the bash nudge waterfall', () => {
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

  const roots: string[] = []
  let context: Context | undefined

  afterEach(async () => {
    await context?.fiber.dispose()
    context = undefined
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  async function workspace(files: Record<string, string> = {}): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codegraph-nudge-'))
    roots.push(root)
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(root, dirname(path)), { recursive: true })
      await writeFile(join(root, path), text)
    }
    return root
  }

  /** A store that claims or refuses a root on demand, or throws to simulate a probe failure. */
  function stubStore(indexes: boolean | 'throw'): CodegraphStoreProvider {
    const node: CodegraphNode = {
      id: CodegraphNodeId('fn:main'),
      kind: 'function',
      name: 'main',
      qualifiedName: 'main',
      filePath: 'app.php',
      language: 'php',
      startLine: 1,
      endLine: 2,
      startColumn: 0,
      endColumn: 0,
      isExported: false,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      decorators: [],
      typeParameters: [],
      updatedAt: 1,
    }
    return {
      id: CodegraphStoreId('stub'),
      indexes: () => {
        if (indexes === 'throw') throw new Error('probe failed')
        return Promise.resolve(indexes)
      },
      query: ((request: { operation: string }) => {
        if (request.operation === 'node') {
          return Promise.resolve({ kind: 'node', node, incoming: [], outgoing: [], alternatives: [] })
        }
        return Promise.resolve({ kind: 'status', projectRoot: '/r', fileCount: 0, nodeCount: 0, edgeCount: 0, languages: [], formatVersion: 4, indexedAt: null, staleFileCount: 0, staleFileCountTruncated: false })
      }) as CodegraphStoreProvider['query'],
    }
  }

  const indexReport: CodegraphIndexReport = {
    projectRoot: '/repo', filesIndexed: 1, filesSkipped: 0, nodeCount: 1, edgeCount: 0,
    unresolvedCount: 0, unresolvedLikelyInternalCount: 0, languages: [{ language: 'php', fileCount: 1 }],
  }

  async function mount(root: string, indexes: boolean | 'throw' = true, config: Record<string, unknown> = {}): Promise<Context> {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(Codegraph)
    ctx.codegraph.registerStore(stubStore(indexes))
    ctx.codegraph.registerIndexer({
      id: CodegraphIndexerId('stub-indexer'),
      canIndex: () => Promise.resolve(true),
      index: projectRoot => Promise.resolve({ ...indexReport, projectRoot }),
    })
    await ctx.plugin(ToolCodegraph, config)
    ctx.tools.register(defineTool({
      name: 'bash',
      description: 'test bash tool',
      parameters: {
        command: { type: 'string' },
        description: { type: 'string' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
        return { ok: true }
      },
    }))
    return ctx
  }

  function agent(ctx: Context, cwd: string): Agent {
    const scope = ctx.plugin(() => {})
    const id = SessionId('codegraph-nudge')
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

  async function callBash(ctx: Context, owner: Agent | undefined, command: string, id: string): Promise<ToolExecutionResult> {
    return ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(id),
      name: 'bash',
      arguments: { command },
      ...owner === undefined ? {} : { agent: owner },
    })
  }

  const nudgeOf = (result: { additionalContexts?: UserMessage[] }) =>
    result.additionalContexts?.find(message => message.source.kind === 'plugin' && message.source.plugin === 'codegraph')

  it('attaches a codegraph-first reminder to a structural bash call when an index exists', async () => {
    const root = await workspace({ 'src/App.php': 'x' })
    const ctx = await mount(root, true)
    const owner = agent(ctx, root)
    const result = await callBash(ctx, owner, 'sed -n \'/function access(/,/^  }/p\' web/core/lib/Drupal/Core/Entity/EntityAccessControlHandler.php | head -80', 'n-1')
    const nudge = nudgeOf(result)
    expect(nudge).toBeDefined()
    expect(nudge?.source).toMatchObject({ kind: 'plugin', plugin: 'codegraph', form: 'notice' })
    const text = nudge?.content.map(block => (block as { text?: string }).text ?? '').join('') ?? ''
    expect(text).toContain('call codegraph first')
    expect(text).toContain('sed')
    expect(result.isError).toBe(false)
  })

  it('does not nudge a bash call that runs something instead of reading code', async () => {
    const root = await workspace()
    const ctx = await mount(root, true)
    const owner = agent(ctx, root)
    for (const [index, command] of [
      'php -l src/App.php',
      'vendor/bin/phpunit --filter Foo 2>&1 | tail -20',
      'composer install',
      'git status',
      'ls -la src/',
    ].entries()) {
      const result = await callBash(ctx, owner, command, `n-${index}`)
      expect(nudgeOf(result), command).toBeUndefined()
    }
  })

  it('fires at the run thresholds, escalates, and stops after the cap', async () => {
    const root = await workspace()
    const ctx = await mount(root, true)
    const owner = agent(ctx, root)
    const fired: number[] = []
    for (let call = 1; call <= 10; call++) {
      const result = await callBash(ctx, owner, `cat web/modules/Foo${call}.php`, `n-${call}`)
      const nudge = nudgeOf(result)
      if (nudge !== undefined) {
        fired.push(call)
        const text = nudge.content.map(block => (block as { text?: string }).text ?? '').join('')
        if (call === 1) expect(text).toContain('call codegraph first')
        else expect(text).toContain(`${call} times`)
      }
    }
    expect(fired).toEqual([1, 3, 5, 8])
  })

  it('resets the run when the agent calls codegraph', async () => {
    const root = await workspace()
    const ctx = await mount(root, true)
    const owner = agent(ctx, root)
    const first = await callBash(ctx, owner, 'cat web/modules/A.php', 'n-a')
    expect(nudgeOf(first)).toBeDefined()
    const reset = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('n-node'),
      name: 'codegraph',
      arguments: { operation: 'node', symbol: 'main' },
      agent: owner,
    })
    expect(reset.isError).toBe(false)
    const after = await callBash(ctx, owner, 'cat web/modules/B.php', 'n-b')
    const nudge = nudgeOf(after)
    expect(nudge).toBeDefined()
    const text = nudge?.content.map(block => (block as { text?: string }).text ?? '').join('') ?? ''
    expect(text).toContain('call codegraph first')
    expect(text).not.toContain('times since the last codegraph call')
  })

  it('resets the run when the agent builds the index', async () => {
    const root = await workspace()
    const ctx = await mount(root, true)
    const owner = agent(ctx, root)
    const first = await callBash(ctx, owner, 'cat web/modules/A.php', 'n-a')
    const second = await callBash(ctx, owner, 'cat web/modules/B.php', 'n-b')
    expect(nudgeOf(second)).toBeUndefined()
    const reset = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('n-index'),
      name: 'codegraph_index',
      arguments: {},
      agent: owner,
    })
    expect(reset.isError).toBe(false)
    const after = await callBash(ctx, owner, 'cat web/modules/C.php', 'n-c')
    const text = nudgeOf(after)?.content.map(block => (block as { text?: string }).text ?? '').join('') ?? ''
    expect(text).toContain('call codegraph first')
  })

  it('stays on the neutral text when the session has no workspace to probe', async () => {
    const root = await workspace()
    const ctx = await mount(root, true)
    const scope = ctx.plugin(() => {})
    const id = SessionId('codegraph-nudge-nocwd')
    const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false })
    const owner: Agent = {
      id, options: {}, session,
      inbox: stubInbox(),
      status: 'idle', ctx: scope.ctx,
      followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(owner)
    const result = await callBash(ctx, owner, 'cat web/modules/A.php', 'n-nocwd')
    const nudge = nudgeOf(result)
    expect(nudge).toBeDefined()
    const text = nudge?.content.map(block => (block as { text?: string }).text ?? '').join('') ?? ''
    expect(text).toContain('codegraph_index')
    expect(text).toContain('works right away')
  })

  it('prepends its notice ahead of contexts a downstream listener adds', async () => {
    const root = await workspace()
    const ctx = await mount(root, true)
    const owner = agent(ctx, root)
    const downstream = createUserMessage({ content: [{ type: 'text', text: 'downstream note' }], source: { kind: 'user' } })
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      const decision = await next()
      return { ...decision, additionalContexts: [downstream, ...(decision.additionalContexts ?? [])] }
    })
    const result = await callBash(ctx, owner, 'cat web/modules/A.php', 'n-order')
    const contexts = result.additionalContexts ?? []
    expect(contexts.map(message => message.source)).toEqual([
      { kind: 'plugin', plugin: 'codegraph', form: 'notice', summary: expect.any(String) },
      { kind: 'user' },
    ])
  })

  it('resets the run when a new user message starts a step', async () => {
    const root = await workspace()
    const ctx = await mount(root, true)
    const owner = agent(ctx, root)
    await callBash(ctx, owner, 'cat web/modules/A.php', 'n-a')
    await callBash(ctx, owner, 'cat web/modules/B.php', 'n-b')
    const userMessage = createUserMessage({ content: [{ type: 'text', text: 'next task' }], source: { kind: 'user' } })
    await ctx.waterfall('agent/pre-step', {
      agent: owner, messages: [userMessage], turn: 1, step: 1, signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter', messages: [userMessage] }))
    const after = await callBash(ctx, owner, 'cat web/modules/C.php', 'n-c')
    const nudge = nudgeOf(after)
    expect(nudge).toBeDefined()
    const text = nudge?.content.map(block => (block as { text?: string }).text ?? '').join('') ?? ''
    expect(text).toContain('call codegraph first')
  })

  it('keeps a non-user step from resetting the run', async () => {
    const root = await workspace()
    const rootCtx = await mount(root, true)
    const owner = agent(rootCtx, root)
    await callBash(rootCtx, owner, 'cat web/modules/A.php', 'n-a')
    await callBash(rootCtx, owner, 'cat web/modules/B.php', 'n-b')
    const toolResult = createUserMessage({
      content: [{ type: 'tool-result', toolCallId: ToolCallId('n-b'), content: [{ type: 'text', text: 'ok' }] }],
      source: { kind: 'tool', callId: ToolCallId('n-b') },
    })
    await rootCtx.waterfall('agent/pre-step', {
      agent: owner, messages: [toolResult], turn: 1, step: 2, signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter', messages: [toolResult] }))
    // The run kept counting (1, 2 → 3): the third firing is the threshold text, not a fresh start.
    const result = await callBash(rootCtx, owner, 'cat web/modules/C.php', 'n-c')
    const nudge = nudgeOf(result)
    expect(nudge).toBeDefined()
    const text = nudge?.content.map(block => (block as { text?: string }).text ?? '').join('') ?? ''
    expect(text).toContain('3 times')
  })

  it('points at codegraph_index instead when the workspace has no index', async () => {
    const root = await workspace()
    const ctx = await mount(root, false)
    const owner = agent(ctx, root)
    const result = await callBash(ctx, owner, 'grep -rn "hook_entity_access" web/modules/', 'n-m')
    const nudge = nudgeOf(result)
    expect(nudge).toBeDefined()
    const text = nudge?.content.map(block => (block as { text?: string }).text ?? '').join('') ?? ''
    expect(text).toContain('codegraph_index')
    expect(text).toContain('no codegraph index')
  })

  it('degrades to the neutral text when the index probe fails', async () => {
    const root = await workspace()
    const ctx = await mount(root, 'throw')
    const owner = agent(ctx, root)
    const result = await callBash(ctx, owner, 'find web/core -name "EntityAccessControlHandler.php"', 'n-u')
    const nudge = nudgeOf(result)
    expect(nudge).toBeDefined()
    const text = nudge?.content.map(block => (block as { text?: string }).text ?? '').join('') ?? ''
    expect(text).toContain('codegraph_index')
    expect(text).toContain('works right away')
  })

  it('stays silent for non-bash tools outside the codegraph family', async () => {
    const root = await workspace()
    const ctx = await mount(root, true)
    const owner = agent(ctx, root)
    ctx.tools.register(defineTool({
      name: 'other',
      description: 'another stub',
      parameters: {
        note: { type: 'string' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
        return { ok: true }
      },
    }))
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('n-other'),
      name: 'other',
      arguments: { note: 'read code with sed' },
      agent: owner,
    })
    expect(nudgeOf(result)).toBeUndefined()
  })

  it('does not nudge a call that carries no agent or no command', async () => {
    const root = await workspace()
    const ctx = await mount(root, true)
    const owner = agent(ctx, root)
    const noAgent = await callBash(ctx, undefined, 'cat web/modules/A.php', 'n-na')
    expect(nudgeOf(noAgent)).toBeUndefined()
    const noCommand = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('n-nc'),
      name: 'bash',
      arguments: {},
      agent: owner,
    })
    expect(nudgeOf(noCommand)).toBeUndefined()
  })

  it('stays silent when the nudge is disabled by configuration', async () => {
    const root = await workspace()
    const ctx = await mount(root, true, { bashNudge: false })
    const owner = agent(ctx, root)
    for (let call = 1; call <= 3; call++) {
      const result = await callBash(ctx, owner, `cat web/modules/F${call}.php`, `n-d-${call}`)
      expect(nudgeOf(result), `call ${call}`).toBeUndefined()
    }
  })
})
