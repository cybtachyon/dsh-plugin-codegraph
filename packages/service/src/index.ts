/**
 * Service Definition for the code-graph capability seam (`ctx.codegraph`): a graph-store provider
 * registry and per-query, order-independent selection over eight normalized graph queries —
 * search, node, callers, callees, impact, trace, files, and status — plus a separate graph-indexer
 * provider registry that builds or refreshes a graph on explicit request.
 *
 * A store reserves a branded id at registration and declares which project roots it can serve
 * through {@link CodegraphStoreProvider.indexes}. Selection asks every registered store per query
 * and requires exactly one claimant, so registration and hot-reload order never change routing;
 * zero claimants and several claimants are both loud failures rather than a silent pick. When no
 * store claims the requested root, selection walks up to the nearest ancestor directory that one
 * does — a query aimed at a subdirectory of an indexed project is answered from that project's
 * index, with its root-relative filters re-prefixed so they still match — and only when no
 * ancestor is indexed at all does a query fail, naming what to build. The seam carries no source
 * text and performs no filesystem access: each probe is a store decision, and retrieving a
 * declaration's code composes a graph query with a `ctx.fs` read in the consumer, which is the only
 * role that can reach a remote workspace's files.
 *
 * An indexer follows the same one-claimant reservation rule, but {@link CodegraphService.index} is
 * never called from {@link CodegraphService.query}: indexing is a caller-initiated, potentially
 * multi-minute operation, and `query` stays read-only so a store never hides a build behind a call the
 * model expects to return quickly.
 * @module @huanlin/dsh-plugin-codegraph-service
 */

import { posix, win32 } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { CodegraphIndexerId, CodegraphStoreId } from './brand.ts'
import type {
  CodegraphIndexer,
  CodegraphIndexReport,
  CodegraphRequest,
  CodegraphResultFor,
  CodegraphService,
  CodegraphStoreProvider,
} from './types.ts'

export { CodegraphIndexerId, CodegraphNodeId, CodegraphStoreId } from './brand.ts'
export type {
  CodegraphCalleesRequest,
  CodegraphCallersRequest,
  CodegraphEdge,
  CodegraphFile,
  CodegraphFilesRequest,
  CodegraphFilesResult,
  CodegraphImpactEntry,
  CodegraphImpactRequest,
  CodegraphImpactResult,
  CodegraphIndexer,
  CodegraphIndexReport,
  CodegraphNode,
  CodegraphNodeRequest,
  CodegraphNodeResult,
  CodegraphOperation,
  CodegraphRelation,
  CodegraphRelationsResult,
  CodegraphRequest,
  CodegraphRequestBase,
  CodegraphResult,
  CodegraphResultFor,
  CodegraphSearchRequest,
  CodegraphSearchResult,
  CodegraphService,
  CodegraphStatusRequest,
  CodegraphStatusResult,
  CodegraphStoreProvider,
  CodegraphTraceHop,
  CodegraphTraceRequest,
  CodegraphTraceResult,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    codegraph: CodegraphService
  }
}

/**
 * Structured code-graph failure. Extends {@link HarnessError} with a stable `code`
 * (`CODEGRAPH_INVALID_PROVIDER`, `CODEGRAPH_CONFLICT`, `CODEGRAPH_UNAVAILABLE`,
 * `CODEGRAPH_UNSUPPORTED_FORMAT`, `CODEGRAPH_MALFORMED_INDEX`, `CODEGRAPH_DISPOSED`,
 * `CODEGRAPH_NO_INDEXER`, …) that callers route on instead of parsing `message`.
 */
export class CodegraphError extends HarnessError {}

/**
 * The declaration categories the on-disk graph format defines. A store may return a kind absent from
 * this list when a newer indexer wrote the graph; consumers treat `kind` as data and use this array
 * only to describe or filter the known vocabulary.
 */
export const NODE_KINDS = [
  'file',
  'module',
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'function',
  'method',
  'property',
  'field',
  'variable',
  'constant',
  'enum',
  'enum_member',
  'type_alias',
  'namespace',
  'parameter',
  'import',
  'export',
  'route',
  'component',
] as const

/**
 * The relationship categories the on-disk graph format defines. Open for the same reason as
 * {@link NODE_KINDS}.
 */
export const EDGE_KINDS = [
  'contains',
  'calls',
  'imports',
  'exports',
  'extends',
  'implements',
  'references',
  'type_of',
  'returns',
  'instantiates',
  'overrides',
  'decorates',
] as const

/**
 * The source languages the on-disk graph format labels files with. Open for the same reason as
 * {@link NODE_KINDS}.
 */
export const LANGUAGES = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'csharp',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'dart',
  'svelte',
  'vue',
  'liquid',
  'pascal',
  'scala',
  'lua',
  'luau',
  'objc',
  'yaml',
  'twig',
  'xml',
  'properties',
  'unknown',
] as const

/**
 * `ctx.codegraph`. Holds the store reservations; selection reads them per query so a store that
 * unloads mid-session stops serving without leaving a stale route behind.
 */
export class Codegraph extends Service implements CodegraphService {
  private readonly stores = new Map<CodegraphStoreId, CodegraphStoreProvider>()
  private readonly indexers = new Map<CodegraphIndexerId, CodegraphIndexer>()

  constructor(ctx: Context) {
    super(ctx, 'codegraph')
  }

  registerStore(provider: CodegraphStoreProvider): () => void {
    const id = provider.id
    if (id.trim() === '') {
      throw new CodegraphError('a code-graph store id must be a non-empty string', 'CODEGRAPH_INVALID_PROVIDER')
    }
    if (this.stores.has(id)) {
      throw new CodegraphError(`a code-graph store with id "${id}" is already registered`, 'CODEGRAPH_CONFLICT')
    }

    const dispose = this.ctx.effect(function* (this: Codegraph) {
      this.stores.set(id, provider)
      yield () => {
        this.stores.delete(id)
      }
    }.bind(this), 'codegraph.registerStore()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is synchronous
    // fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  registerIndexer(provider: CodegraphIndexer): () => void {
    const id = provider.id
    if (id.trim() === '') {
      throw new CodegraphError('a code-graph indexer id must be a non-empty string', 'CODEGRAPH_INVALID_PROVIDER')
    }
    if (this.indexers.has(id)) {
      throw new CodegraphError(`a code-graph indexer with id "${id}" is already registered`, 'CODEGRAPH_CONFLICT')
    }

    const dispose = this.ctx.effect(function* (this: Codegraph) {
      this.indexers.set(id, provider)
      yield () => {
        this.indexers.delete(id)
      }
    }.bind(this), 'codegraph.registerIndexer()')
    return () => void dispose()
  }

  /**
   * Whether a query against `projectRoot` can be answered without a build: true when any store
   * indexes the root itself or a nearest-first ancestor of it, false when nothing up the tree
   * carries an index. Several claimants on one candidate still count as available — the conflict
   * stays the query's to report, with its store ids, rather than this probe hiding it.
   * @param projectRoot - absolute path of the project root to check.
   * @param signal - aborts the availability checks.
   * @returns true when {@link query} can serve this root or one of its ancestors right now.
   */
  async available(projectRoot: string, signal?: AbortSignal): Promise<boolean> {
    for (const candidate of ancestorCandidates(projectRoot)) {
      const claimants = await this.claimants(candidate, signal)
      if (claimants.length > 0) return true
    }
    return false
  }

  /**
   * The root a query against `projectRoot` would be served from: the requested root when a store
   * indexes it, the nearest indexed ancestor directory otherwise, and the requested root UNCHANGED
   * when no ancestor is indexed — a caller distinguishes "served from an ancestor" from
   * "unindexed" by comparing the answer with what it asked. A candidate several stores claim fails
   * loudly with the same conflict a direct query would raise, so this never hides a miswired
   * deployment the way a silent skip would.
   * @param projectRoot - absolute path to resolve.
   * @param signal - aborts the availability checks.
   * @returns the root to run the query — and any source reads keyed to it — against.
   */
  async resolveRoot(projectRoot: string, signal?: AbortSignal): Promise<string> {
    for (const candidate of ancestorCandidates(projectRoot)) {
      const claimants = await this.claimants(candidate, signal)
      if (claimants.length === 1) return candidate
      if (claimants.length > 1) throw this.conflict(candidate, claimants)
    }
    return projectRoot
  }

  async index(projectRoot: string, signal?: AbortSignal): Promise<CodegraphIndexReport> {
    // The run replaces the graph file by renaming the rebuilt one over it, and Windows refuses
    // that rename while any reader in this process still holds the old file open — so every
    // store's connections for this root are closed before the indexer starts. On POSIX the close
    // is unobservable; on Windows it is the difference between a rebuild that lands and one that
    // fails EPERM on every attempt for as long as the process lives.
    this.release(projectRoot)
    const indexer = await this.selectIndexer(projectRoot, signal)
    return indexer.index(projectRoot, signal)
  }

  /**
   * Close every open connection the registered stores keep for `projectRoot`. A store that keeps
   * none — or none for this root — contributes nothing; the seam never fails a caller because one
   * store had nothing to release.
   * @param projectRoot - absolute path of the project root whose readers to release.
   */
  release(projectRoot: string): void {
    for (const store of this.stores.values()) store.release?.(projectRoot)
  }

  async query<R extends CodegraphRequest>(request: R, signal?: AbortSignal): Promise<CodegraphResultFor<R>> {
    const route = await this.select(request.projectRoot, signal)
    const routed = route.root === request.projectRoot
      ? request
      : this.rebasePathForRoot(request, request.projectRoot, route.root)
    return route.store.query(routed, signal)
  }

  /**
   * The one store that serves a query asked against `projectRoot`, with the root it actually
   * indexes. Every registered store is asked for each candidate concurrently, so the answer does
   * not depend on registration order; several claimants on one candidate throw. The requested root
   * comes first — an index it carries wins over any ancestor's — then each ancestor directory
   * nearest-first, so a subdirectory of an indexed project is answered from that project's index
   * instead of failing. Only when no ancestor is indexed at all does selection fail, and the
   * message then says what to build instead of repeating the call that just failed.
   * @param projectRoot - absolute path of the project root to route to.
   * @param signal - aborts the availability checks.
   * @returns the single claiming store and the root its index was built for.
   */
  private async select(projectRoot: string, signal?: AbortSignal): Promise<StoreRoute> {
    for (const candidate of ancestorCandidates(projectRoot)) {
      const claimants = await this.claimants(candidate, signal)
      if (claimants.length === 1) {
        // The filter just proved claimants holds exactly one entry; the assertion only satisfies
        // noUncheckedIndexedAccess, no branch is implied.
        const only = claimants[0]!
        return { store: only, root: candidate }
      }
      if (claimants.length > 1) throw this.conflict(candidate, claimants)
    }
    throw new CodegraphError(
      `no code-graph store indexes "${projectRoot}" or any ancestor directory — no codegraph index exists anywhere up the tree from it. ` +
        `Build one with codegraph_index at the root of the project you mean (its repository root, not a subdirectory of an already-indexed project), then retry.`,
      'CODEGRAPH_UNAVAILABLE',
    )
  }

  /** The stores that claim one candidate root, in registration order. */
  private async claimants(candidate: string, signal?: AbortSignal): Promise<CodegraphStoreProvider[]> {
    const stores = [...this.stores.values()]
    const claims = await Promise.all(stores.map(store => store.indexes(candidate, signal)))
    return stores.filter((_, index) => claims[index])
  }

  /** The one-claimant rule's failure: several stores indexing the same root is a miswired deployment. */
  private conflict(candidate: string, claimants: readonly CodegraphStoreProvider[]): CodegraphError {
    const ids = claimants.map(store => store.id).join(', ')
    return new CodegraphError(`several code-graph stores index "${candidate}": ${ids}`, 'CODEGRAPH_CONFLICT')
  }

  /**
   * A query routed to an ancestor index still means what the model asked: its `path` and `pattern`
   * filters are relative to the root IT named, but the store reads them relative to the index root
   * it serves, so each filter is re-prefixed with the requested root's segment under that index.
   * Without this, `search path:modules/node` asked of `web/core` would filter on `modules/node/…`
   * in an index whose paths start at the project root, matching nothing.
   * @param request - the routed request, before the store sees it.
   * @param requested - the root the caller asked about.
   * @param resolved - the ancestor root the query is served from.
   * @returns the request re-anchored to the index root — `projectRoot` always, the filters
   * re-prefixed. Only called on a root the caller's own walk produced, so the relation always
   * holds; {@link anchorPrefix} throws `CODEGRAPH_INTERNAL` if it ever does not, rather than a
   * filter being re-anchored against an unverifiable relation the store would match nothing with.
   */
  private rebasePathForRoot<R extends CodegraphRequest>(request: R, requested: string, resolved: string): R {
    // `resolved` comes from this call's own ancestor walk, so it is always a true ancestor of
    // `requested` and the prefix exists; anchorPrefix's guard is the invariant check, not a
    // routing branch.
    const prefix = anchorPrefix(resolved, requested)
    switch (request.operation) {
      case 'search':
        return { ...request, projectRoot: resolved, ...(request.path === undefined ? {} : { path: prefixFilter(request.path, prefix) }) } as R
      case 'files':
        return {
          ...request,
          projectRoot: resolved,
          ...(request.path === undefined ? {} : { path: prefixFilter(request.path, prefix) }),
          ...(request.pattern === undefined ? {} : { pattern: prefixFilter(request.pattern, prefix) }),
        } as R
      default:
        return { ...request, projectRoot: resolved } as R
    }
  }

  /**
   * The one indexer that claims `projectRoot`. Every registered indexer is asked concurrently, so the
   * answer does not depend on registration order; zero and several claimants both throw.
   * @param projectRoot - absolute path of the project root to index.
   * @param signal - aborts the availability checks.
   * @returns the single claiming indexer.
   */
  private async selectIndexer(projectRoot: string, signal?: AbortSignal): Promise<CodegraphIndexer> {
    const candidates = [...this.indexers.values()]
    const claims = await Promise.all(candidates.map(indexer => indexer.canIndex(projectRoot, signal)))
    const claimants = candidates.filter((_, index) => claims[index])
    const [only, rival] = claimants
    if (only === undefined) {
      throw new CodegraphError(`no code-graph indexer can index "${projectRoot}"`, 'CODEGRAPH_NO_INDEXER')
    }
    if (rival !== undefined) {
      const ids = claimants.map(indexer => indexer.id).join(', ')
      throw new CodegraphError(`several code-graph indexers can index "${projectRoot}": ${ids}`, 'CODEGRAPH_CONFLICT')
    }
    return only
  }
}

/** The store serving a routed query, with the root its index was built for (the routing decision's answer). */
interface StoreRoute {
  readonly store: CodegraphStoreProvider
  readonly root: string
}

/**
 * Largest number of candidate roots selection probes for one request: the requested root plus this
 * many ancestor directories. Deep enough for any plausible home-directory layout, bounded so a
 * request against an abnormally deep unindexed tree spends a bounded number of probes rather than
 * walking all the way to the filesystem root on every call.
 */
const MAX_ANCESTOR_PROBES = 12

/**
 * The parent directory of one path, or `undefined` at the filesystem root. Separator-aware: a path
 * carrying backslashes walks with the Windows rules, one with slashes with the POSIX rules, so a
 * store probing a host path of either style terminates at the right place.
 * @param root - one candidate root.
 * @returns its parent directory, or `undefined` when it is already the filesystem root.
 */
function parentOf(root: string): string | undefined {
  const impl = root.includes('\\') ? win32 : posix
  const parent = impl.dirname(root)
  return parent === root || parent === '.' ? undefined : parent
}

/**
 * The requested root followed by each ancestor directory, nearest first, for as long as the walk
 * stays within {@link MAX_ANCESTOR_PROBES}. Selection probes the list in order, so the first
 * indexed candidate it meets is the nearest one.
 * @param root - the root the caller asked about.
 * @returns the probe order for that root's resolution.
 */
function ancestorCandidates(root: string): string[] {
  const candidates = [root]
  let current = root
  while (candidates.length <= MAX_ANCESTOR_PROBES) {
    const parent = parentOf(current)
    if (parent === undefined) break
    current = parent
    candidates.push(current)
  }
  return candidates
}

/**
 * The prefix that re-anchors a filter written against a descendant root into the index root a
 * query is served from: the segment between the two, with a trailing separator in the descendant's
 * own style — a Windows path keeps backslashes end to end, even where the relative segment carries
 * none of its own.
 * @param ancestor - the index root a query is served from.
 * @param descendant - the root the caller asked about, under the ancestor.
 * @returns the prefix to prepend to root-relative filters.
 * @throws {CodegraphError} `CODEGRAPH_INTERNAL` when the two roots do not stand in an ancestor
 * relation — unreachable through routing, where the ancestor comes from the caller's own walk, but
 * load-bearing if this helper is ever reused against arbitrary pairs.
 */
export function anchorPrefix(ancestor: string, descendant: string): string {
  const impl = descendant.includes('\\') ? win32 : posix
  const rel = impl.relative(ancestor, descendant)
  if (rel === '' || rel.startsWith('..')) {
    throw new CodegraphError(`cannot re-anchor "${descendant}" against "${ancestor}": not an ancestor relation`, 'CODEGRAPH_INTERNAL')
  }
  return `${rel}${impl === win32 ? '\\' : '/'}`
}

/**
 * Re-anchor one root-relative filter under the segment between an index root and the root a caller
 * asked about, stripping a redundant leading separator the caller may have written.
 * @param filter - the caller's filter, relative to the root it named.
 * @param prefix - the segment that separates that root from the index root, with its trailing separator.
 * @returns the filter relative to the index root.
 */
function prefixFilter(filter: string, prefix: string): string {
  return `${prefix}${filter.replace(/^[/\\]+/, '')}`
}

export default Codegraph
