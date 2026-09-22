/**
 * Model-facing text for each operation's canonical value.
 *
 * Every line leads with `path:line` so a location can be acted on directly, and a truncated answer
 * always says so — a capped list that reads as complete is worse than a short one, because the model
 * concludes it has seen everything.
 * @module @huanlin/dsh-plugin-codegraph-tool/render
 */

import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { CodegraphToolValue } from './schema.ts'

/** A symbol as one scannable line. */
function symbolLine(symbol: {
  name: string
  kind: string
  path: string
  line: number
  exported: boolean
  signature?: string
}): string {
  const exported = symbol.exported ? '' : ' (local)'
  const signature = symbol.signature === undefined ? '' : `  ${symbol.signature.replaceAll('\n', ' ')}`
  return `${symbol.path}:${symbol.line}  ${symbol.kind} ${symbol.name}${exported}${signature}`
}

/** The `N shown of M` suffix a truncatable list carries. */
function counted(shown: number, total: number, truncated: boolean): string {
  return truncated ? ` (${shown} of ${total} shown)` : ` (${total})`
}

/** A fenced source block, labelled with the line the slice starts at. */
function codeBlock(path: string, code: string | null, startLine: number | undefined): string[] {
  if (code === null) return [`  (source unavailable for ${path})`]
  const from = startLine === undefined ? '' : ` from line ${startLine}`
  return [`  ${path}${from}:`, '```', code, '```']
}

/**
 * The retry guidance an empty answer appends after naming what was asked. An empty answer that
 * says nothing about HOW to retry is what sends a model into a loop of guessing symbols and
 * failing again, so every empty message ends with the next call to make: the index stores
 * declarations, and `search` is the fuzzy path that finds the exact names to feed back.
 * @param subject - the text the model asked for, when the operation takes one.
 * @returns the guidance sentence, or `''` when the operation carries no subject to name.
 */
function noMatchGuidance(operation: CodegraphToolValue['operation'], subject: string | undefined): string {
  if (subject === undefined) return ''
  const quoted = ` "${subject}"`
  switch (operation) {
    case 'search':
      return ` The index stores declarations only — names in comments or strings do not appear. Try a different or shorter identifier, or the grep tool for a literal text match.`
    case 'explore':
      return ` Each word is searched on its own, so none of the words matched a declaration. Try a different identifier, or the grep tool for a literal text match.`
    case 'node':
      return ` node resolves a simple name, or a member written as Class::member or in the index's own convention. Run search${quoted} to list the closest names, then pass one of them to node.`
    case 'callers':
    case 'callees':
    case 'impact':
      return ` Run search${quoted} to find the closest name, then retry.`
    case 'trace':
      return ` At least one endpoint is not an indexed name. Run search for each endpoint to find the closest names, then retry.`
    default:
      return ''
  }
}

/**
 * Render one result as the text the model reads.
 * @param value - the canonical value the operation returned.
 * @param subject - the text the model asked for (query, symbol, or endpoints), so an empty answer
 * can name it and point at the retry that resolves it; the tool's render callback supplies it.
 * @returns the rendered text.
 */
export function renderCodegraph(value: CodegraphToolValue, subject?: string): string {
  const empty = () => `No declaration matches${subject === undefined ? '' : ` "${subject}"`} in ${value.project_path}.${noMatchGuidance(value.operation, subject)}`
  switch (value.operation) {
    case 'search': {
      if (value.symbols.length === 0) return empty()
      const header = `Declarations${counted(value.symbols.length, value.total, value.truncated)}:`
      return [header, ...value.symbols.map(symbol => symbolLine(symbol))].join('\n')
    }
    case 'node': {
      if (value.symbol === null) return empty()
      const lines = [symbolLine(value.symbol)]
      if (value.symbol.docstring !== undefined) lines.push(`  ${value.symbol.docstring.replaceAll('\n', '\n  ')}`)
      if (value.alternatives.length > 0) {
        lines.push(`Also named this${counted(value.alternatives.length, value.alternatives.length, false)}:`)
        lines.push(...value.alternatives.map(symbol => `  ${symbolLine(symbol)}`))
      }
      if (value.incoming.length > 0) {
        lines.push('Reached by:')
        lines.push(...value.incoming.map(relation => `  [${relation.via}] ${symbolLine(relation)}`))
      }
      if (value.outgoing.length > 0) {
        lines.push('Reaches:')
        lines.push(...value.outgoing.map(relation => `  [${relation.via}] ${symbolLine(relation)}`))
      }
      if (value.code !== null) lines.push(...codeBlock(value.symbol.path, value.code, value.symbol.line))
      return lines.join('\n')
    }
    case 'callers':
    case 'callees': {
      if (value.symbol === null) return empty()
      const direction = value.operation === 'callers' ? 'Callers of' : 'Called by'
      if (value.relations.length === 0) return `${direction} ${symbolLine(value.symbol)}: none in the index.`
      const header = `${direction} ${value.symbol.name}${counted(value.relations.length, value.total, value.truncated)}:`
      return [
        header,
        ...value.relations.map((relation) => {
          const site = relation.site_line === undefined ? '' : ` at line ${relation.site_line}`
          const repeats = relation.site_count > 1 ? ` ×${relation.site_count}` : ''
          return `${symbolLine(relation)}${site}${repeats}`
        }),
      ].join('\n')
    }
    case 'impact': {
      if (value.symbol === null) return empty()
      if (value.affected.length === 0) return `Nothing in the index depends on ${value.symbol.name}.`
      const header = `Changing ${value.symbol.name} can affect${counted(value.affected.length, value.total, value.truncated)}:`
      return [
        header,
        ...value.affected.map(entry => `${symbolLine(entry)}  [${entry.distance} hop${entry.distance === 1 ? '' : 's'}, via ${entry.via}]`),
      ].join('\n')
    }
    case 'trace': {
      if (value.from === null || value.to === null) return empty()
      if (value.paths.length === 0) {
        return `No call path from ${value.from.name} to ${value.to.name} within the searched depth. The flow may cross a dynamic dispatch the index cannot follow.`
      }
      const lines = [`${value.paths.length} path${value.paths.length === 1 ? '' : 's'} from ${value.from.name} to ${value.to.name}:`]
      value.paths.forEach((path, index) => {
        lines.push(`Path ${index + 1}:`)
        for (const hop of path) {
          const via = hop.via === undefined ? '' : ` [${hop.via}${hop.site_line === undefined ? '' : ` at line ${hop.site_line}`}]`
          lines.push(`  ${symbolLine(hop)}${via}`)
        }
      })
      return lines.join('\n')
    }
    case 'files': {
      if (value.files.length === 0) return `No indexed file matches in ${value.project_path}.`
      const header = `Indexed files${counted(value.files.length, value.total, value.truncated)}:`
      return [
        header,
        ...value.files.map(file => `${file.path}  ${file.language}  ${file.symbol_count} symbols`),
      ].join('\n')
    }
    case 'status': {
      if (!value.indexed) {
        return `No index for \`${value.project_path}\`. If \`${value.project_path}\` is a container directory holding the project, pass the project's own root as project_path and retry; otherwise run codegraph_index on it to build one.`
      }
      const languages = (value.languages ?? []).map(entry => `${entry.language} ${entry.file_count}`).join(', ')
      const indexedAt = value.indexed_at
      const indexed = indexedAt === undefined || indexedAt === null ? 'never' : new Date(indexedAt).toISOString()
      const lines = [
        `Index for ${value.project_path} (format version ${value.format_version}):`,
        `${value.file_count} files, ${value.symbol_count} symbols, ${value.edge_count} relationships.`,
        `Languages: ${languages || 'none'}.`,
        `Last indexed: ${indexed}.`,
      ]
      const stale = value.stale_file_count
      // Undefined only when a caller builds a partial value directly (as some tests do); the tool's
      // own `status` handler always sets this alongside `indexed: true`.
      if (stale !== undefined && stale > 0) {
        const truncated = value.stale_file_count_truncated === true
        const amount = truncated ? `at least ${stale}` : `${stale}`
        const noun = stale === 1 && !truncated ? 'file' : 'files'
        lines.push(`${amount} indexed ${noun} changed on disk or went missing since indexing. Call codegraph_index to refresh.`)
      }
      return lines.join('\n')
    }
    case 'explore': {
      if (value.files.length === 0) return empty()
      const lines = [`Source for ${value.files.length} file${value.files.length === 1 ? '' : 's'}${value.truncated ? ` (of ${value.total} matched)` : ''}:`]
      for (const file of value.files) {
        lines.push(...file.symbols.map(symbol => symbolLine(symbol)))
        lines.push(...codeBlock(file.path, file.code, file.code_start_line))
        if (file.truncated) lines.push('  (source truncated)')
      }
      return lines.join('\n')
    }
    case 'context': {
      if (value.entry_points.length === 0) return `Nothing in the index matches "${value.task}".`
      const lines = [`Context for "${value.task}":`, 'Entry points:']
      lines.push(...value.entry_points.map(symbol => `  ${symbolLine(symbol)}`))
      if (value.related.length > 0) {
        lines.push('Related:')
        lines.push(...value.related.map(relation => `  [${relation.via}] ${symbolLine(relation)}`))
      }
      for (const file of value.files) {
        lines.push(...codeBlock(file.path, file.code, file.code_start_line))
        if (file.truncated) lines.push('  (source truncated)')
      }
      return lines.join('\n')
    }
    case 'index': {
      const languages = value.languages.map(entry => `${entry.language} ${entry.file_count}`).join(', ')
      const unresolved = value.unresolved_count === 0
        ? 'Every call site resolved.'
        : `${value.unresolved_likely_internal_count} of ${value.unresolved_count} unresolved call sites look like genuine gaps; the rest are member calls or already-imported names, never workspace-edge candidates.`
      return [
        `Indexed ${value.project_path}:`,
        `${value.files_indexed} files indexed, ${value.files_skipped} skipped.`,
        `${value.symbol_count} symbols, ${value.edge_count} relationships. ${unresolved}`,
        `Languages: ${languages || 'none'}.`,
      ].join('\n')
    }
    /* v8 ignore next -- exhaustive over the output schema's closed union; unreachable. */
    default:
      return assertNever(value, 'tool-codegraph output')
  }
}
