// Local-only smoke against a real workspace indexed by the external codegraph CLI. Self-skips when
// that index is absent, so it never gates CI; it exists to prove the assembled tool answers from an
// index this repository did not create.
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Codegraph from '@huanlin/dsh-plugin-codegraph-service'
import * as FsLocal from '@deepseek-ai/dsh-fs-local'
import * as CodegraphSqlite from '@huanlin/dsh-plugin-codegraph-sqlite'
import * as ToolCodegraph from '@huanlin/dsh-plugin-codegraph-tool'

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

// Opt-in: point DSH_CODEGRAPH_LIVE_ROOT at a workspace the external codegraph CLI has indexed.
const WORKSPACE = process.env['DSH_CODEGRAPH_LIVE_ROOT'] ?? ''
const present = WORKSPACE !== '' && existsSync(join(WORKSPACE, '.codegraph/codegraph.db'))

/**
 * Two same-file class names and one method written in the model's `Class::member` form, picked from
 * the live index itself so the regression test works against any format the CLI stamps (v4 from the
 * plugin's indexer, v8/v9 from the CLI) in any repository.
 */
function pickSymbols(): {
  className: string
  otherClassName: string
  methodSymbol: string
  methodName: string
  methodPath: string
} | null {
  if (!present) return null
  const db = new DatabaseSync(join(WORKSPACE, '.codegraph/codegraph.db'), { readOnly: true })
  try {
    const classes = db
      .prepare('SELECT name FROM nodes WHERE kind = \'class\' AND name != \'\' ORDER BY length(name) DESC, name LIMIT 2')
      .all() as { name: string }[]
    if (classes.length < 2) return null
    const method = db
      .prepare('SELECT name, qualified_name, file_path FROM nodes WHERE kind = \'method\' AND qualified_name LIKE \'%::%\' AND name != \'\' LIMIT 1')
      .get() as { name: string; qualified_name: string; file_path: string } | undefined
    if (method === undefined) return null
    // The model writes the last two container segments; the separator it uses may differ from the
    // one the index stored, which is exactly what the fallback must absorb.
    const segments = method.qualified_name.split(/::|\./)
    const [container, member] = segments.slice(-2)
    return {
      className: classes[0]!.name,
      otherClassName: classes[1]!.name,
      methodSymbol: `${container}::${member}`,
      methodName: method.name,
      methodPath: method.file_path,
    }
  } finally {
    db.close()
  }
}

const picked = pickSymbols()

async function bootContext(): Promise<Context> {
  const boot = await mkdtemp(join(tmpdir(), 'dsh-codegraph-live-'))
  bootPath = boot
  const configPath = join(boot, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-fs-local'",
    '  config:',
    `    cwd: ${JSON.stringify(WORKSPACE)}`,
    "- name: '@huanlin/dsh-plugin-codegraph-service'",
    "- name: '@huanlin/dsh-plugin-codegraph-sqlite'",
    "- name: '@huanlin/dsh-plugin-codegraph-tool'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(boot).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-fs-local', FsLocal],
    ['@huanlin/dsh-plugin-codegraph-service', Codegraph],
    ['@huanlin/dsh-plugin-codegraph-sqlite', CodegraphSqlite],
    ['@huanlin/dsh-plugin-codegraph-tool', ToolCodegraph],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

function liveAgent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('codegraph-live')
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: WORKSPACE, isSeeded: false })
  const owner: Agent = {
    id,
    options: {},
    session,
    inbox: stubInbox(),
    status: 'idle',
    ctx: scope.ctx,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(owner)
  return owner
}

let bootPath: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (bootPath !== undefined) await rm(bootPath, { recursive: true, force: true })
  bootPath = undefined
})

describe.skipIf(!present)('tool-codegraph against a live external index', () => {
  it('answers every operation from the assembled tool', async () => {
    const ctx = await bootContext()
    const owner = liveAgent(ctx)

    const calls: Record<string, unknown>[] = [
      { operation: 'status' },
      { operation: 'search', query: 'useUrlState', limit: 3 },
      { operation: 'node', symbol: 'useUrlState', limit: 3 },
      { operation: 'callers', symbol: 'useUrlState', limit: 4 },
      { operation: 'callees', symbol: 'AdapterListPage', limit: 4 },
      { operation: 'impact', symbol: 'useUrlState', depth: 2, limit: 4 },
      { operation: 'trace', from: 'AdapterListPage', to: 'useUrlState' },
      { operation: 'files', pattern: 'src/hooks/*', limit: 4 },
      { operation: 'explore', query: 'useUrlState', limit: 3 },
      { operation: 'context', task: 'how does url state sync with the adapter list page' },
    ]
    const transcript: string[] = []
    for (const [index, args] of calls.entries()) {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(`live-${index}`),
        name: 'codegraph',
        arguments: args,
        agent: owner,
      })
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
      transcript.push(`### ${JSON.stringify(args['operation'])} (isError=${result.isError})\n${text}`)
      expect(result.isError).toBe(false)
    }
    await writeFile(join(tmpdir(), 'dsh-codegraph-live-tool.md'), transcript.join('\n\n'))
  }, 60_000)

  // The two query shapes that failed against the guestwi.se index and came back fine from the
  // CLI: several identifiers in one search/explore, and a member written Class::member.
  it.runIf(picked !== null)('answers the multi-identifier and Class::member query shapes', async () => {
    const target = picked!
    const ctx = await bootContext()
    const owner = liveAgent(ctx)
    let callNumber = 0
    const run = async (args: Record<string, unknown>): Promise<string> => {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(`live-regression-${callNumber++}`),
        name: 'codegraph',
        arguments: args,
        agent: owner,
      })
      expect(result.isError, `isError for ${JSON.stringify(args)}`).toBe(false)
      return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
    }

    const pair = `${target.className} ${target.otherClassName}`
    // Each word of a multi-identifier query is searched on its own and merged; the old code sent
    // the whole string as one substring, so both identifiers in the query found nothing.
    const search = await run({ operation: 'search', query: pair, limit: 10 })
    expect(search).toContain(target.className)
    expect(search).toContain(target.otherClassName)
    const explore = await run({ operation: 'explore', query: pair, limit: 3 })
    expect(explore).toContain(target.className)

    // A member written in the model's Class::member form resolves against a graph that stored the
    // namespace- or file-qualified spelling, and the answer carries the declaration's own location.
    const node = await run({ operation: 'node', symbol: target.methodSymbol, limit: 3, include_code: true })
    expect(node).toContain(target.methodName)
    expect(node).toContain(target.methodPath)
  }, 60_000)
})
