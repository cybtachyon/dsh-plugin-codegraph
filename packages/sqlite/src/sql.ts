/**
 * SQL fragments shared by the store's queries: the column projections the row mappers expect, the
 * ranking expressions that decide which declaration a bare symbol name means, and the escaping that
 * makes an arbitrary model-supplied string a safe FTS5 query.
 *
 * Ranking is expressed in SQL rather than in TypeScript so ordering and truncation happen in the
 * same statement: a `LIMIT` must keep the most relevant matches, which it can only do if the
 * database already knows the order.
 * @module @huanlin/dsh-plugin-codegraph-sqlite/sql
 */

/** Every `nodes` column {@link toNode} reads, aliased `n`. */
export const NODE_COLUMNS = [
  'n.id',
  'n.kind',
  'n.name',
  'n.qualified_name',
  'n.file_path',
  'n.language',
  'n.start_line',
  'n.end_line',
  'n.start_column',
  'n.end_column',
  'n.docstring',
  'n.signature',
  'n.visibility',
  'n.is_exported',
  'n.is_async',
  'n.is_static',
  'n.is_abstract',
  'n.decorators',
  'n.type_parameters',
  'n.updated_at',
].join(', ')

/**
 * Relevance among declarations that share a name. A bare name in a query means the thing that
 * declares behaviour, so callable and type declarations outrank the values and re-exports that
 * merely mention the same identifier: an `import { parse }` node must never win over the `parse`
 * function it imports, and a `file` node never wins at all.
 */
const KIND_RANK_CASE = `CASE n.kind
  WHEN 'function' THEN 0
  WHEN 'method' THEN 0
  WHEN 'class' THEN 1
  WHEN 'component' THEN 1
  WHEN 'struct' THEN 1
  WHEN 'interface' THEN 2
  WHEN 'trait' THEN 2
  WHEN 'protocol' THEN 2
  WHEN 'type_alias' THEN 3
  WHEN 'enum' THEN 3
  WHEN 'route' THEN 3
  WHEN 'constant' THEN 4
  WHEN 'variable' THEN 4
  WHEN 'property' THEN 5
  WHEN 'field' THEN 5
  WHEN 'enum_member' THEN 5
  WHEN 'parameter' THEN 6
  WHEN 'namespace' THEN 6
  WHEN 'module' THEN 6
  WHEN 'import' THEN 7
  WHEN 'export' THEN 7
  WHEN 'file' THEN 8
  ELSE 6
END`

/**
 * How exactly a candidate matched the requested symbol: a fully qualified name beats a
 * case-sensitive simple name, which beats a case-insensitive one, which beats a member-suffix
 * fallback (`Class::method` written in one separator convention matching an index that stored the
 * other). Binds the symbol three times and, when the fallback is active, one parameter per
 * fallback pattern, ahead of the other order-by parameters.
 */
function symbolTierCase(patterns: readonly string[]): string {
  const memberCase = patterns.length === 0
    ? '  ELSE 3\n'
    : `  WHEN ${patterns.map(() => "lower(n.qualified_name) LIKE ? ESCAPE '\\'").join('\n    OR ')} THEN 3\n  ELSE 4\n`
  return `CASE
  WHEN n.qualified_name = ? THEN 0
  WHEN n.name = ? THEN 1
  WHEN lower(n.name) = lower(?) THEN 2
${memberCase}END`
}

/**
 * How a candidate matched a free-text search: an exact name beats a case-insensitive one, which
 * beats a prefix, which beats any other match (a substring, or a documentation or signature hit).
 * Binds the query four times.
 */
const SEARCH_TIER_CASE = `CASE
  WHEN n.name = ? THEN 0
  WHEN lower(n.name) = lower(?) THEN 1
  WHEN lower(n.name) LIKE lower(?) || '%' THEN 2
  WHEN lower(n.qualified_name) LIKE '%' || lower(?) || '%' THEN 3
  ELSE 4
END`

/**
 * Order candidates for a symbol lookup: match exactness first, then declaration relevance, then
 * exported over internal, then file and line so equally ranked results never reorder between runs.
 * Binds the symbol three times and, when the member-suffix fallback is active, one parameter per
 * fallback pattern, ahead of any other parameter in the statement.
 * @param patterns - the fallback patterns the matching `WHERE` carries; pass none for an exact-only lookup.
 * @returns the `ORDER BY` expression.
 */
export function symbolOrder(patterns: readonly string[] = []): string {
  return `${symbolTierCase(patterns)}, ${KIND_RANK_CASE}, n.is_exported DESC, n.file_path, n.start_line`
}

/** The exact-only order, for a symbol lookup that carries no member-suffix fallback. */
export const SYMBOL_ORDER = symbolOrder()

/** Order candidates for a free-text search. Binds the query four times. */
export const SEARCH_ORDER = `${SEARCH_TIER_CASE}, ${KIND_RANK_CASE}, n.is_exported DESC, n.file_path, n.start_line`

/**
 * Turn a model-supplied string into an FTS5 prefix query that cannot be misread as FTS syntax.
 * Doubling the quote characters and wrapping the whole value in quotes makes it one literal phrase,
 * so `AND`, `*`, `:` and parentheses in a symbol name search for themselves instead of changing the
 * query's meaning.
 * @param query - the raw search text.
 * @returns an FTS5 MATCH expression matching the text as a prefix phrase.
 */
export function ftsPhrase(query: string): string {
  return `"${query.replaceAll('"', '""')}"*`
}

/**
 * Escape the `LIKE` wildcard characters in a string so they match literally.
 * @param text - the raw text, already in whatever case the caller wants.
 * @returns the escaped text, for use inside a `LIKE ? ESCAPE '\\'` pattern.
 */
export function escapeLike(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

/**
 * Wrap a raw string as a SQL `LIKE` pattern matching it anywhere, escaping the wildcard characters
 * so a symbol containing `%` or `_` matches literally.
 * @param query - the raw search text.
 * @returns the escaped pattern, for use with `LIKE ? ESCAPE '\\'`.
 */
export function likeAnywhere(query: string): string {
  return `%${escapeLike(query.toLowerCase())}%`
}

/**
 * The member separators the on-disk formats place between a container and its member: `::` (PHP's
 * `Namespace::Class::method`, and the `file::Class` prefix every format uses), `.` (TypeScript's
 * `file::Class.member`), and `#` (the Ruby and Java-style convention models reach for). A symbol
 * written with any one of them must resolve against an index that stored any other.
 */
export const MEMBER_SEPARATORS = ['::', '.', '#'] as const

/**
 * Largest number of separator occurrences one symbol may contribute fallback patterns for, so a
 * pathological string cannot grow an unbounded `OR` clause.
 */
const MAX_MEMBER_PATTERNS = 8

/**
 * The fallback patterns that let a symbol written with one member-separator convention match an
 * index that stored the same declaration with another.
 *
 * The symbol is split at EVERY occurrence of ANY of the three separators, and each `(owner, member)`
 * pair is re-joined with EVERY separator the formats use: `Codegraph::registerStore` thus matches
 * an index recording `src/util.ts::Codegraph.registerStore`, and `Group::hasPermission` matches
 * `Drupal\group\Entity::Group::hasPermission`. The patterns are `lower()`ed suffixes, so a class
 * whose name is a superstring of the requested one (`SubGroup`) can match — the exact tiers win
 * first, and the `node` answer's `alternatives` list lets the caller see the ambiguity.
 * @param symbol - the raw symbol as the model wrote it.
 * @returns the distinct escaped lowercase patterns, or `null` when the symbol carries no member
 * separator and no fallback applies.
 */
export function memberSuffixPatterns(symbol: string): string[] | null {
  const lower = symbol.toLowerCase()
  const patterns = new Set<string>()
  let occurrences = 0
  for (let i = 0; i < lower.length; i++) {
    const separator = MEMBER_SEPARATORS.find(candidate => lower.startsWith(candidate, i))
    if (separator === undefined) continue
    if (occurrences >= MAX_MEMBER_PATTERNS) break
    occurrences += 1
    const owner = lower.slice(0, i)
    const member = lower.slice(i + separator.length)
    if (owner === '' || member === '') continue
    for (const joiner of MEMBER_SEPARATORS) {
      patterns.add(`%${escapeLike(owner)}${joiner}${escapeLike(member)}`)
    }
  }
  return patterns.size === 0 ? null : [...patterns]
}
