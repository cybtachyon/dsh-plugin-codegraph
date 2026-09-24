import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Codegraph, {
  CodegraphError,
  CodegraphIndexerId,
  CodegraphNodeId,
  CodegraphStoreId,
  anchorPrefix,
  EDGE_KINDS,
  LANGUAGES,
  NODE_KINDS,
} from '../src/index.ts'
import type { CodegraphIndexer, CodegraphIndexReport, CodegraphRequest, CodegraphStoreProvider } from '../src/index.ts'

const STATUS = {
  kind: 'status' as const,
  projectRoot: '/repo',
  fileCount: 1,
  nodeCount: 2,
  edgeCount: 3,
  languages: [],
  formatVersion: 4,
  indexedAt: null,
  staleFileCount: 0,
  staleFileCountTruncated: false,
}

/** A store that claims the roots it was told to, and answers `status` with a marker. */
function stubStore(id: string, roots: readonly string[]): CodegraphStoreProvider {
  return {
    id: CodegraphStoreId(id),
    indexes: (projectRoot: string) => Promise.resolve(roots.includes(projectRoot)),
    query: ((request: CodegraphRequest) =>
      Promise.resolve({ ...STATUS, projectRoot: `${id}:${request.projectRoot}` })) as CodegraphStoreProvider['query'],
  }
}

async function seam(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Codegraph)
  return ctx
}

const STATUS_REQUEST = { operation: 'status', projectRoot: '/repo' } as const

describe('codegraph seam', () => {
  it('routes a query to the one store claiming the root', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('a', ['/repo']))
    ctx.codegraph.registerStore(stubStore('b', ['/other']))
    const result = await ctx.codegraph.query(STATUS_REQUEST)
    expect(result.projectRoot).toBe('a:/repo')
  })

  it('forwards the caller signal to store selection and query', async () => {
    const ctx = await seam()
    const indexes = vi.fn(() => Promise.resolve(true))
    const query = vi.fn(() => Promise.resolve(STATUS))
    ctx.codegraph.registerStore({
      id: CodegraphStoreId('spy'),
      indexes,
      query: query as unknown as CodegraphStoreProvider['query'],
    })
    const signal = new AbortController().signal
    await ctx.codegraph.query(STATUS_REQUEST, signal)
    expect(indexes).toHaveBeenCalledWith('/repo', signal)
    expect(query).toHaveBeenCalledWith(STATUS_REQUEST, signal)
  })

  it('rejects an empty store id without publishing anything', async () => {
    const ctx = await seam()
    expect(() => ctx.codegraph.registerStore(stubStore('  ', ['/repo'])))
      .toThrow(expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_INVALID_PROVIDER' }))
    await expect(ctx.codegraph.query(STATUS_REQUEST)).rejects.toThrow(/no code-graph store indexes/)
  })

  it('rejects a duplicate store id', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('a', ['/repo']))
    expect(() => ctx.codegraph.registerStore(stubStore('a', ['/elsewhere'])))
      .toThrow(expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_CONFLICT' }))
  })

  it('fails loud when no store indexes the root', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('a', ['/other']))
    await expect(ctx.codegraph.query(STATUS_REQUEST)).rejects.toThrow(
      expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_UNAVAILABLE' }),
    )
  })

  it('fails loud rather than picking between two stores that claim one root', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('a', ['/repo']))
    ctx.codegraph.registerStore(stubStore('b', ['/repo']))
    await expect(ctx.codegraph.query(STATUS_REQUEST)).rejects.toThrow(
      expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_CONFLICT' }),
    )
    await expect(ctx.codegraph.query(STATUS_REQUEST)).rejects.toThrow(/a, b/)
  })

  it('releases the reservation when its disposer runs', async () => {
    const ctx = await seam()
    const dispose = ctx.codegraph.registerStore(stubStore('a', ['/repo']))
    await expect(ctx.codegraph.query(STATUS_REQUEST)).resolves.toBeDefined()
    dispose()
    await expect(ctx.codegraph.query(STATUS_REQUEST)).rejects.toThrow(/no code-graph store indexes/)
    // The same id is free again, proving the reservation was released rather than merely hidden.
    expect(() => ctx.codegraph.registerStore(stubStore('a', ['/repo']))).not.toThrow()
  })

  it('unregisters a store when its owning fiber unloads', async () => {
    const ctx = await seam()
    const fiber = ctx.plugin({
      inject: ['codegraph'],
      apply(scope: Context) {
        scope.codegraph.registerStore(stubStore('scoped', ['/repo']))
      },
    })
    await fiber.await()
    await expect(ctx.codegraph.query(STATUS_REQUEST)).resolves.toBeDefined()
    await fiber.dispose()
    await expect(ctx.codegraph.query(STATUS_REQUEST)).rejects.toThrow(/no code-graph store indexes/)
  })

  it('brands ids as plain strings', () => {
    expect(CodegraphNodeId('function:1')).toBe('function:1')
    expect(CodegraphStoreId('store')).toBe('store')
  })

  it('publishes the on-disk format vocabulary', () => {
    expect(NODE_KINDS).toContain('function')
    expect(EDGE_KINDS).toContain('calls')
    expect(LANGUAGES).toContain('typescript')
  })
})

/** An indexer that claims the roots it was told to, and reports a marked project root. */
function stubIndexer(id: string, roots: readonly string[]): CodegraphIndexer {
  return {
    id: CodegraphIndexerId(id),
    canIndex: (projectRoot: string) => Promise.resolve(roots.includes(projectRoot)),
    index: (projectRoot: string) => Promise.resolve({
      projectRoot: `${id}:${projectRoot}`,
      filesIndexed: 1,
      filesSkipped: 0,
      nodeCount: 1,
      edgeCount: 0,
      unresolvedCount: 0,
      unresolvedLikelyInternalCount: 0,
      languages: [],
    } satisfies CodegraphIndexReport),
  }
}

describe('codegraph release', () => {
  it('closes the stores\' open connections for a root before an index run replaces the file', async () => {
    const ctx = await seam()
    // Sequenced by hand rather than invocationCallOrder: one shared list proves release ran
    // first without reaching into vitest's per-mock ordering bookkeeping.
    const order: string[] = []
    const release = vi.fn((_projectRoot: string) => {
      order.push('release')
    })
    ctx.codegraph.registerStore({
      id: CodegraphStoreId('pooled'),
      indexes: (projectRoot: string) => Promise.resolve(projectRoot === '/repo'),
      query: ((request: CodegraphRequest) =>
        Promise.resolve({ ...STATUS, projectRoot: request.projectRoot })) as CodegraphStoreProvider['query'],
      release,
    })
    ctx.codegraph.registerIndexer({
      id: CodegraphIndexerId('spy'),
      canIndex: () => Promise.resolve(true),
      index: (projectRoot: string) => {
        order.push('index')
        return Promise.resolve({
          projectRoot,
          filesIndexed: 0,
          filesSkipped: 0,
          nodeCount: 0,
          edgeCount: 0,
          unresolvedCount: 0,
          unresolvedLikelyInternalCount: 0,
          languages: [],
        } satisfies CodegraphIndexReport)
      },
    })

    await expect(ctx.codegraph.index('/repo')).resolves.toBeDefined()
    expect(release).toHaveBeenCalledWith('/repo')
    // Released BEFORE the run, not after: the replace needs the readers gone first. On Windows the
    // replace refuses with EPERM for as long as an open connection holds the old file.
    expect(order).toEqual(['release', 'index'])
  })

  it('treats release as optional: a store without it still serves queries and takes an index run', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('plain', ['/repo']))
    ctx.codegraph.registerIndexer(stubIndexer('a', ['/repo']))
    await expect(ctx.codegraph.index('/repo')).resolves.toBeDefined()
    await expect(ctx.codegraph.query(STATUS_REQUEST)).resolves.toBeDefined()
  })
})

describe('codegraph indexer registry', () => {
  it('runs the one indexer claiming the root', async () => {
    const ctx = await seam()
    ctx.codegraph.registerIndexer(stubIndexer('a', ['/repo']))
    ctx.codegraph.registerIndexer(stubIndexer('b', ['/other']))
    const report = await ctx.codegraph.index('/repo')
    expect(report.projectRoot).toBe('a:/repo')
  })

  it('forwards the caller signal to indexer selection and the run', async () => {
    const ctx = await seam()
    const canIndex = vi.fn(() => Promise.resolve(true))
    const index = vi.fn(() => Promise.resolve({
      projectRoot: '/repo',
      filesIndexed: 0,
      filesSkipped: 0,
      nodeCount: 0,
      edgeCount: 0,
      unresolvedCount: 0,
      unresolvedLikelyInternalCount: 0,
      languages: [],
    } satisfies CodegraphIndexReport))
    ctx.codegraph.registerIndexer({ id: CodegraphIndexerId('spy'), canIndex, index })
    const signal = new AbortController().signal
    await ctx.codegraph.index('/repo', signal)
    expect(canIndex).toHaveBeenCalledWith('/repo', signal)
    expect(index).toHaveBeenCalledWith('/repo', signal)
  })

  it('rejects an empty indexer id without publishing anything', async () => {
    const ctx = await seam()
    expect(() => ctx.codegraph.registerIndexer(stubIndexer('  ', ['/repo'])))
      .toThrow(expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_INVALID_PROVIDER' }))
    await expect(ctx.codegraph.index('/repo')).rejects.toThrow(/no code-graph indexer can index/)
  })

  it('rejects a duplicate indexer id', async () => {
    const ctx = await seam()
    ctx.codegraph.registerIndexer(stubIndexer('a', ['/repo']))
    expect(() => ctx.codegraph.registerIndexer(stubIndexer('a', ['/elsewhere'])))
      .toThrow(expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_CONFLICT' }))
  })

  it('fails loud as CODEGRAPH_NO_INDEXER when no indexer can index the root', async () => {
    const ctx = await seam()
    ctx.codegraph.registerIndexer(stubIndexer('a', ['/other']))
    await expect(ctx.codegraph.index('/repo')).rejects.toThrow(
      expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_NO_INDEXER' }),
    )
  })

  it('fails loud rather than picking between two indexers that claim one root', async () => {
    const ctx = await seam()
    ctx.codegraph.registerIndexer(stubIndexer('a', ['/repo']))
    ctx.codegraph.registerIndexer(stubIndexer('b', ['/repo']))
    await expect(ctx.codegraph.index('/repo')).rejects.toThrow(
      expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_CONFLICT' }),
    )
    await expect(ctx.codegraph.index('/repo')).rejects.toThrow(/a, b/)
  })

  it('releases the reservation when its disposer runs', async () => {
    const ctx = await seam()
    const dispose = ctx.codegraph.registerIndexer(stubIndexer('a', ['/repo']))
    await expect(ctx.codegraph.index('/repo')).resolves.toBeDefined()
    dispose()
    await expect(ctx.codegraph.index('/repo')).rejects.toThrow(/no code-graph indexer can index/)
    expect(() => ctx.codegraph.registerIndexer(stubIndexer('a', ['/repo']))).not.toThrow()
  })

  it('unregisters an indexer when its owning fiber unloads', async () => {
    const ctx = await seam()
    const fiber = ctx.plugin({
      inject: ['codegraph'],
      apply(scope: Context) {
        scope.codegraph.registerIndexer(stubIndexer('scoped', ['/repo']))
      },
    })
    await fiber.await()
    await expect(ctx.codegraph.index('/repo')).resolves.toBeDefined()
    await fiber.dispose()
    await expect(ctx.codegraph.index('/repo')).rejects.toThrow(/no code-graph indexer can index/)
  })
})

describe('codegraph availability', () => {
  it('reports unavailable when no store claims the root', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('a', ['/other']))
    await expect(ctx.codegraph.available('/repo')).resolves.toBe(false)
  })

  it('reports available when exactly one store claims the root', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('a', ['/repo']))
    await expect(ctx.codegraph.available('/repo')).resolves.toBe(true)
  })

  it('reports available even when several stores claim the root, leaving query to report the conflict', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('a', ['/repo']))
    ctx.codegraph.registerStore(stubStore('b', ['/repo']))
    await expect(ctx.codegraph.available('/repo')).resolves.toBe(true)
    await expect(ctx.codegraph.query(STATUS_REQUEST)).rejects.toThrow(
      expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_CONFLICT' }),
    )
  })

  it('forwards the caller signal to every store\'s availability check', async () => {
    const ctx = await seam()
    const indexes = vi.fn(() => Promise.resolve(true))
    ctx.codegraph.registerStore({
      id: CodegraphStoreId('spy'),
      indexes,
      query: () => Promise.reject(new Error('not queried')),
    })
    const signal = new AbortController().signal
    await ctx.codegraph.available('/repo', signal)
    expect(indexes).toHaveBeenCalledWith('/repo', signal)
  })
})

// A request aimed at a subdirectory of an indexed root must be answered from that root's index —
// never bounced back at the caller with advice that repeats the call it just made.
describe('codegraph ancestor resolution', () => {
  it('serves a subdirectory query from the nearest indexed ancestor', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('a', ['/repo']))
    const result = await ctx.codegraph.query({ operation: 'status', projectRoot: '/repo/sub' })
    expect(result.projectRoot).toBe('a:/repo')
  })

  it('keeps an exact-root index ahead of an ancestor index', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('a', ['/repo/sub']))
    ctx.codegraph.registerStore(stubStore('b', ['/repo']))
    await expect(ctx.codegraph.query({ operation: 'status', projectRoot: '/repo/sub' }))
      .resolves.toMatchObject({ projectRoot: 'a:/repo/sub' })
    await expect(ctx.codegraph.query({ operation: 'status', projectRoot: '/repo/other' }))
      .resolves.toMatchObject({ projectRoot: 'b:/repo' })
  })

  it('re-anchors path and pattern filters to the index root when routing to an ancestor', async () => {
    const ctx = await seam()
    const seen: CodegraphRequest[] = []
    ctx.codegraph.registerStore({
      id: CodegraphStoreId('spy'),
      indexes: projectRoot => Promise.resolve(projectRoot === '/repo'),
      query: request => {
        seen.push(request)
        return Promise.resolve(STATUS)
      },
    })
    await ctx.codegraph.query({ operation: 'search', projectRoot: '/repo/sub', query: 'main', path: 'mod', limit: 5 })
    await ctx.codegraph.query({ operation: 'files', projectRoot: '/repo/sub/deep', path: 'dir', pattern: 'x/*.ts', limit: 5 })
    expect(seen[0]).toMatchObject({ operation: 'search', projectRoot: '/repo', path: 'sub/mod' })
    expect(seen[1]).toMatchObject({ operation: 'files', projectRoot: '/repo', path: 'sub/deep/dir', pattern: 'sub/deep/x/*.ts' })
    // A filter the caller did not set stays absent rather than arriving as `undefined`.
    await ctx.codegraph.query({ operation: 'search', projectRoot: '/repo/sub', query: 'main', limit: 5 })
    await ctx.codegraph.query({ operation: 'files', projectRoot: '/repo/sub/deep', path: 'dir', limit: 5 })
    await ctx.codegraph.query({ operation: 'files', projectRoot: '/repo/sub/deep', pattern: 'x/*.ts', limit: 5 })
    expect(seen[2]).toMatchObject({ operation: 'search', projectRoot: '/repo' })
    expect(seen[2]).not.toHaveProperty('path')
    expect(seen[3]).toMatchObject({ operation: 'files', projectRoot: '/repo', path: 'sub/deep/dir' })
    expect(seen[3]).not.toHaveProperty('pattern')
    expect(seen[4]).toMatchObject({ operation: 'files', projectRoot: '/repo', pattern: 'sub/deep/x/*.ts' })
    expect(seen[4]).not.toHaveProperty('path')
  })

  it('strips a leading separator the caller wrote on a re-anchored filter', async () => {
    const ctx = await seam()
    const seen: CodegraphRequest[] = []
    ctx.codegraph.registerStore({
      id: CodegraphStoreId('spy'),
      indexes: projectRoot => Promise.resolve(projectRoot === '/repo'),
      query: request => {
        seen.push(request)
        return Promise.resolve(STATUS)
      },
    })
    await ctx.codegraph.query({ operation: 'search', projectRoot: '/repo/sub', query: 'main', path: '/mod', limit: 5 })
    expect(seen[0]).toMatchObject({ projectRoot: '/repo', path: 'sub/mod' })
  })

  it('does not re-anchor filters when the query is served from the exact root', async () => {
    const ctx = await seam()
    const seen: CodegraphRequest[] = []
    ctx.codegraph.registerStore({
      id: CodegraphStoreId('spy'),
      indexes: projectRoot => Promise.resolve(projectRoot === '/repo'),
      query: request => {
        seen.push(request)
        return Promise.resolve(STATUS)
      },
    })
    const request = { operation: 'search', projectRoot: '/repo', query: 'main', path: 'mod', limit: 5 }
    await ctx.codegraph.query(request)
    expect(seen[0]).toMatchObject({ projectRoot: '/repo', path: 'mod' })
  })

  it('reports a conflict at the nearest indexed ancestor rather than skipping to a farther one', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('a', ['/repo']))
    ctx.codegraph.registerStore(stubStore('b', ['/repo']))
    ctx.codegraph.registerStore(stubStore('c', ['/']))
    await expect(ctx.codegraph.query({ operation: 'status', projectRoot: '/repo/sub' }))
      .rejects.toThrow(/several code-graph stores index "\/repo"/)
  })

  it('fails with build guidance when no ancestor is indexed', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('a', ['/elsewhere']))
    await expect(ctx.codegraph.query({ operation: 'status', projectRoot: '/repo/sub' }))
      .rejects.toThrow(/no code-graph store indexes "\/repo\/sub" or any ancestor directory/)
    await expect(ctx.codegraph.query({ operation: 'status', projectRoot: '/repo/sub' }))
      .rejects.toThrow(/Build one with codegraph_index/)
  })

  it('resolveRoot returns the requested root, the nearest indexed ancestor, or the request itself', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('a', ['/repo']))
    expect(await ctx.codegraph.resolveRoot('/repo')).toBe('/repo')
    expect(await ctx.codegraph.resolveRoot('/repo/sub')).toBe('/repo')
    expect(await ctx.codegraph.resolveRoot('/elsewhere/sub')).toBe('/elsewhere/sub')
  })

  it('resolveRoot fails loudly on a conflicting candidate, like a query would', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('a', ['/repo']))
    ctx.codegraph.registerStore(stubStore('b', ['/repo']))
    await expect(ctx.codegraph.resolveRoot('/repo/sub')).rejects
      .toThrow(expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_CONFLICT' }))
  })

  it('reports available for a subdirectory of an indexed ancestor, not for an unindexed one', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('a', ['/repo']))
    await expect(ctx.codegraph.available('/repo/sub')).resolves.toBe(true)
    await expect(ctx.codegraph.available('/elsewhere/sub')).resolves.toBe(false)
  })

  it('stops the ancestor walk at its probe cap rather than reaching a far ancestor', async () => {
    const ctx = await seam()
    const probed: string[] = []
    ctx.codegraph.registerStore({
      id: CodegraphStoreId('spy'),
      indexes: root => {
        probed.push(root)
        return Promise.resolve(root === '/a')
      },
      query: () => Promise.resolve(STATUS),
    })
    await expect(
      ctx.codegraph.query({ operation: 'status', projectRoot: '/a/b/c/d/e/f/g/h/i/j/k/l/m/n' }),
    ).rejects.toThrow(/no code-graph store indexes/)
    // Thirteen probes: the requested root plus twelve ancestors, stopping one directory short of
    // the index the store claims — a cap, not a silent miss of a plausible root.
    expect(probed).toHaveLength(13)
    expect(probed.at(-1)).toBe('/a/b')
    expect(probed).not.toContain('/a')
  })

  it('stops a walk started from a relative path before the current directory', async () => {
    const ctx = await seam()
    const probed: string[] = []
    ctx.codegraph.registerStore({
      id: CodegraphStoreId('spy'),
      indexes: root => {
        probed.push(root)
        return Promise.resolve(root === '.')
      },
      query: () => Promise.resolve(STATUS),
    })
    await expect(ctx.codegraph.query({ operation: 'status', projectRoot: 'a/b' })).rejects
      .toThrow(/no code-graph store indexes/)
    expect(probed).toEqual(['a/b', 'a'])
  })

  it('walks a trailing-slash request up without re-probing the same directory', async () => {
    const ctx = await seam()
    const probed: string[] = []
    const seen: CodegraphRequest[] = []
    ctx.codegraph.registerStore({
      id: CodegraphStoreId('spy'),
      indexes: root => {
        probed.push(root)
        return Promise.resolve(root === '/repo')
      },
      query: request => {
        seen.push(request)
        return Promise.resolve(STATUS)
      },
    })
    await ctx.codegraph.query({ operation: 'search', projectRoot: '/repo/sub/', query: 'main', path: 'mod', limit: 5 })
    expect(probed).toEqual(['/repo/sub/', '/repo'])
    expect(seen[0]).toMatchObject({ projectRoot: '/repo', path: 'sub/mod' })
  })

  it('resolves and re-anchors Windows-style paths with the Windows rules', async () => {
    const ctx = await seam()
    const seen: CodegraphRequest[] = []
    ctx.codegraph.registerStore({
      id: CodegraphStoreId('spy'),
      indexes: root => Promise.resolve(root === 'C:\\proj'),
      query: request => {
        seen.push(request)
        return Promise.resolve(STATUS)
      },
    })
    await ctx.codegraph.query({
      operation: 'search', projectRoot: 'C:\\proj\\sub\\deep', query: 'main', path: 'mod', limit: 5,
    })
    expect(seen[0]).toMatchObject({ projectRoot: 'C:\\proj', path: 'sub\\deep\\mod' })
    expect(await ctx.codegraph.resolveRoot('C:\\proj\\sub')).toBe('C:\\proj')
  })
})

describe('anchorPrefix', () => {
  it('joins the segment with the descendant path separator', () => {
    expect(anchorPrefix('/repo', '/repo/sub')).toBe('sub/')
    expect(anchorPrefix('/repo', '/repo/sub/deep')).toBe('sub/deep/')
    expect(anchorPrefix('C:\\proj', 'C:\\proj\\sub')).toBe('sub\\')
    expect(anchorPrefix('C:\\proj', 'C:\\proj\\sub\\deep')).toBe('sub\\deep\\')
  })

  it('throws on a pair that is not an ancestor relation', () => {
    expect(() => anchorPrefix('/a', '/b')).toThrow(expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_INTERNAL' }))
    expect(() => anchorPrefix('/a', '/a')).toThrow(expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_INTERNAL' }))
    expect(() => anchorPrefix('/a/b', '/a/c')).toThrow(expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_INTERNAL' }))
  })
})
