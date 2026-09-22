/**
 * The moment-of-action side of the codegraph-first rule. A system-prompt section states the
 * preference, but a mid-prompt paragraph does not reach a model at the exact step where it reaches
 * for `sed -n '1,200p'` to find out where a symbol is declared. This module answers that step:
 * the bash call that reads, searches, or locates code gets one advisory plugin context attached
 * to its own result, naming codegraph as the first attempt — and escalating while the run goes on.
 *
 * The classifier is deliberately permissive about what counts as "reading code" (`sed`, `cat`,
 * `head`, `tail`, `grep`, `rg`, `find -name`, …) and strict about what does not: runners and
 * builders (`php`, `phpunit`, `composer`, `git`, …), listings, and file mutations. A nudge that
 * fired on `phpunit` would teach the model to distrust the tool that actually runs things, which
 * is the opposite of the intent.
 *
 * The classifier is a heuristic, not a shell parser: quote-aware segment splitting plus a verb
 * table, trading a few false positives and negatives for the small cost of a one-line reminder.
 * @module @huanlin/dsh-plugin-codegraph-tool/nudge
 */

/** Verbs whose use on a code path reads code rather than running it. */
const READ_VERBS = new Set(['sed', 'cat', 'head', 'tail', 'tac', 'nl'])

/** Verbs that search file contents. */
const SEARCH_VERBS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag'])

/** `find` flags that ask for files by name or path, as opposed to listing a tree. */
const FIND_NAME_FLAGS = new Set(['-name', '-iname', '-path', '-ipath', '-regex', '-iregex', '-lname'])

/** `grep`/`rg` flags that search a tree, so a bare pattern is still a codebase search. */
const RECURSIVE_FLAGS = new Set(['-r', '-R', '-rn', '--recursive'])

/**
 * Split one shell command into independent segments, honoring single and double quotes so a
 * quoted alternation (`grep -i "a|b" file`) stays inside one segment.
 * @param command - the raw `bash` command string.
 * @returns the trimmed, non-empty segments.
 */
export function commandSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: "'" | '"' | undefined
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (quote === undefined) {
      if (char === "'" || char === '"') {
        quote = char
        current += char
        continue
      }
      if (char === '&' || char === '|' || char === ';' || char === '\n') {
        segments.push(current)
        current = ''
        if ((char === '&' || char === '|') && command[i + 1] === char) i++
        continue
      }
      current += char
    } else {
      current += char
      if (char === quote) quote = undefined
    }
  }
  segments.push(current)
  return segments.map(segment => segment.trim()).filter(segment => segment !== '')
}

/**
 * A file argument a read verb was given: a path containing a slash whose final segment carries a
 * non-leading dot. The slash requirement keeps bare filenames (`cat .env`) out, and the dot rule
 * keeps a `sed` script address (`/function access(/,/^  }/p`) from masquerading as a file.
 * @param token - one whitespace-separated command token.
 * @returns whether the token is a code file path.
 */
export function isCodeFileToken(token: string): boolean {
  if (!token.includes('/')) return false
  const last = token.slice(token.lastIndexOf('/') + 1)
  return last.includes('.') && !last.startsWith('.')
}

/**
 * Whether a search-verb segment targets files: a recursive flag, or any argument containing a
 * slash. A bare pattern (`git log | grep x`) targets stdin, so it does not count.
 * @param tokens - the segment's tokens, verb first.
 * @returns whether the segment searches a codebase.
 */
export function hasSearchTarget(tokens: readonly string[]): boolean {
  return tokens.some(token => RECURSIVE_FLAGS.has(token) || token.includes('/'))
}

/**
 * The introspection verb one segment represents, or `undefined` when the segment does not read
 * code: the verb table decides, then the argument shape confirms it is aimed at files.
 * @param segment - one command segment, already trimmed.
 * @returns the verb name when the segment reads, searches, or locates code.
 */
export function segmentIntrospectionVerb(segment: string): string | undefined {
  const tokens = segment.split(/\s+/).filter(token => token !== '')
  if (tokens.length === 0) return undefined
  // The filter just proved tokens[0] is a non-empty string; the assertion only satisfies
  // noUncheckedIndexedAccess, no branch is implied.
  const verb = tokens[0]!
  if (verb === 'xargs') {
    // `find … | xargs grep -l foo`: the payload verb decides.
    return tokens.slice(1).find(token => READ_VERBS.has(token) || SEARCH_VERBS.has(token))
  }
  if (READ_VERBS.has(verb)) {
    return tokens.slice(1).some(isCodeFileToken) ? verb : undefined
  }
  if (SEARCH_VERBS.has(verb)) {
    return hasSearchTarget(tokens) ? verb : undefined
  }
  if (verb === 'find') {
    return tokens.some(token => FIND_NAME_FLAGS.has(token)) ? 'find' : undefined
  }
  return undefined
}

/**
 * Whether one bash command reads, searches, or locates code — the call shape the codegraph-first
 * rule exists to intercept.
 * @param command - the raw `bash` command string.
 * @returns whether any segment is a code-introspection call.
 */
export function isCodeIntrospectionCommand(command: string): boolean {
  return commandSegments(command).some(segment => segmentIntrospectionVerb(segment) !== undefined)
}

/**
 * The distinct introspection verbs across a command's segments, in first-seen order — the
 * reminder quotes them so the model sees the rule attached to what it actually did.
 * @param command - the raw `bash` command string.
 * @returns the verb names, e.g. `['sed', 'grep']`.
 */
export function introspectionVerbs(command: string): string[] {
  const seen: string[] = []
  for (const segment of commandSegments(command)) {
    const verb = segmentIntrospectionVerb(segment)
    if (verb !== undefined && !seen.includes(verb)) seen.push(verb)
  }
  return seen
}

/**
 * The `command` string of a bash call's parsed arguments, when it carries a usable one.
 * @param argumentsValue - the call's parsed arguments (`unknown` until the bash schema says otherwise).
 * @returns the command string, or `undefined` when the call has no command to classify.
 */
export function bashCommand(argumentsValue: unknown): string | undefined {
  if (typeof argumentsValue !== 'object' || argumentsValue === null) return undefined
  const command = (argumentsValue as { command?: unknown }).command
  return typeof command === 'string' && command.trim() !== '' ? command : undefined
}

/** Whether the workspace has a codegraph index the reminder can point at. */
export type IndexAvailability = 'available' | 'missing' | 'unknown'

/**
 * The reminder text for one firing: it escalates with the call count in the run and adapts to
 * whether an index exists to answer from — without one, pointing the model at `codegraph` would
 * only hand it a loud failure, so the missing variant names `codegraph_index` instead.
 * @param count - how many introspection bash calls the agent has made this run.
 * @param availability - the index probe outcome for the agent's workspace.
 * @param verbs - the comma-joined introspection verbs the command used.
 * @returns the model-facing reminder text.
 */
export function nudgeText(count: number, availability: IndexAvailability, verbs: string): string {
  if (availability === 'available') {
    return count === 1
      ? `That bash call read code with ${verbs}. For structural questions about existing code — where a symbol is declared, what calls it, what a change reaches — call codegraph first: \`codegraph node <symbol>\` returns the declaration with its code and relations, no file path needed (a symbol is a simple name, Class::member like Group::hasPermission, or the qualified name a search returns); \`search\` and \`explore\` take several identifiers space-separated in one call, and \`context\` answers a task. Keep bash for running things (builds, tests, commands) and the read tool for whole files.`
      : `You have read code with bash ${count} times since the last codegraph call, and this workspace has an index. Use it: \`codegraph node <symbol>\` (declaration + code + relations), \`search\` and \`explore\` with space-separated identifiers, \`context <task>\`. It returns the exact declarations instead of unbounded sed/grep output, and finds files whose path you do not know. Use bash to run things and read for whole files.`
  }
  if (availability === 'missing') {
    return `This workspace has no codegraph index yet, so structural code questions have no fast path. If you plan to keep reading code with bash, build one now: call \`codegraph_index\` with this project's root, then use \`codegraph\` — it answers from the index (declaration + code + relations, no path needed) and costs less than repeated sed/grep. Until it exists, bash and the read tool are the fallbacks.`
  }
  return `If you keep reading code with bash, consider the \`codegraph\` tool: it answers structural questions — where a symbol is declared, what calls it — from a pre-built index with far less output than sed/grep. If this workspace has no index yet, call \`codegraph_index\` with the project's root first; if it does, \`codegraph node <symbol>\` works right away.`
}

/** The one-line notice summary (bounded by the context form) for one firing. */
export function nudgeSummary(count: number, availability: IndexAvailability, verbs: string): string {
  return availability === 'missing'
    ? 'codegraph index missing — build with codegraph_index'
    : `codegraph first · bash ${verbs} × ${count}`
}
