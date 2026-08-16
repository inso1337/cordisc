import { FunctionExpression, Node, Project, SourceFile, SyntaxKind } from 'ts-morph'
import fs from 'node:fs'
import path from 'node:path'

export interface BuildResult {
  /** Files written to the out directory (relative paths). */
  written: string[]
  /** Number of effect callbacks lowered. */
  lowered: number
  /** Effects left untouched, with the reason. */
  skipped: { file: string; line: number; reason: string }[]
}

interface Edit {
  start: number
  end: number
  text: string
}

const PRELUDE = `const __cordisc_inverses: Array<() => unknown> = []
const __cordisc_dispose = () => {
  let __task: any
  for (let __i = __cordisc_inverses.length - 1; __i >= 0; __i--) {
    const __d = __cordisc_inverses[__i]
    if (__task) __task = __task.then(__d)
    else {
      const __r = __d()
      if (__r && typeof (__r as any).then === 'function') __task = __r
    }
  }
  return __task
}
`

/**
 * Lower synchronous generator effect callbacks into single closures.
 *
 * A synchronous generator passed to `ctx.effect()` cannot be interrupted
 * between yields — the runtime drains it in one tick, so its iteration
 * boundaries are unobservable (the paper's L-Divert can only fall at a
 * boundary an `await` opens). Fusing the yields into one accumulated
 * disposer is therefore semantics-preserving, and removes the generator
 * object, the iterator protocol, and the runtime's per-step tracking.
 *
 * Async generators keep real boundaries (partial rollback between awaits)
 * and are deliberately left untouched.
 */
export function build(options: { project: string; outDir: string }): BuildResult {
  const project = new Project({ tsConfigFilePath: options.project })
  const baseDir = path.dirname(path.resolve(options.project))
  const outDir = path.resolve(options.outDir)
  const result: BuildResult = { written: [], lowered: 0, skipped: [] }

  for (const file of project.getSourceFiles()) {
    const filePath = file.getFilePath()
    if (filePath.includes('/node_modules/')) continue
    const edits: Edit[] = []
    for (const callback of findEffectGenerators(file)) {
      const failure = collectEdits(callback, edits)
      if (failure) {
        const { line } = file.getLineAndColumnAtPos(callback.getStart())
        result.skipped.push({ file: filePath, line, reason: failure })
      } else {
        result.lowered++
      }
    }
    const output = applyEdits(file.getFullText(), edits)
    const relative = path.relative(baseDir, filePath)
    const target = path.join(outDir, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, output)
    result.written.push(relative)
  }
  return result
}

/** Find synchronous generator function expressions passed to `.effect()`. */
function findEffectGenerators(file: SourceFile): FunctionExpression[] {
  const found: FunctionExpression[] = []
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression()
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'effect') continue
    const receiver = callee.getExpression().getType()
    const symbolName = (receiver.getSymbol() ?? receiver.getAliasSymbol())?.getName()
    if (symbolName !== 'Context' && symbolName !== 'Fiber') continue
    const arg = call.getArguments()[0]
    if (!arg || !Node.isFunctionExpression(arg)) continue
    if (!arg.isGenerator() || arg.isAsync()) continue
    found.push(arg)
  }
  return found
}

/**
 * Compute the text edits that lower one generator. Returns a bail reason
 * (and contributes no edits) when the generator uses a shape the lowering
 * cannot preserve.
 */
function collectEdits(fn: FunctionExpression, edits: Edit[]): string | undefined {
  const body = fn.getBody()
  if (!Node.isBlock(body)) return 'generator body is not a block'

  const yields: Node[] = []
  const returns: Node[] = []
  const isFunctionLike = (a: Node) =>
    Node.isFunctionDeclaration(a) || Node.isFunctionExpression(a) || Node.isArrowFunction(a) ||
    Node.isMethodDeclaration(a) || Node.isConstructorDeclaration(a) ||
    Node.isGetAccessorDeclaration(a) || Node.isSetAccessorDeclaration(a)
  for (const node of body.getDescendants()) {
    // only this generator's own yields/returns — nested functions keep theirs
    const owner = node.getFirstAncestor(isFunctionLike)
    if (owner !== fn) continue
    if (Node.isYieldExpression(node)) {
      if (node.getFirstChildByKind(SyntaxKind.AsteriskToken)) return 'yield* delegation is not lowerable'
      if (!Node.isExpressionStatement(node.getParent()!)) return 'yield used as an expression value'
      if (!node.getExpression()) return 'bare yield without a disposable'
      yields.push(node.getParent()!)
    } else if (Node.isReturnStatement(node)) {
      returns.push(node)
    }
  }

  const pending: Edit[] = []

  const asterisk = fn.getFirstChildByKind(SyntaxKind.AsteriskToken)
  if (!asterisk) return 'missing asterisk token'
  pending.push({ start: asterisk.getStart(), end: asterisk.getEnd(), text: '' })

  const statements = body.getStatements()
  const preludePos = statements.length ? statements[0]!.getStart() : body.getEnd() - 1
  pending.push({ start: preludePos, end: preludePos, text: PRELUDE })

  for (const statement of yields) {
    const expr = (statement.getChildAtIndex(0) as any).getExpression().getText()
    pending.push({
      start: statement.getStart(),
      end: statement.getEnd(),
      text: `{ const __v = ${expr}; if (__v) __cordisc_inverses.push(__v as () => unknown) }`,
    })
  }

  for (const statement of returns) {
    const expr = (statement as any).getExpression()?.getText()
    pending.push({
      start: statement.getStart(),
      end: statement.getEnd(),
      text: expr
        ? `{ const __v = ${expr}; if (__v) __cordisc_inverses.push(__v as () => unknown); return __cordisc_dispose }`
        : `return __cordisc_dispose`,
    })
  }

  const last = statements.at(-1)
  if (!last || !Node.isReturnStatement(last)) {
    const closePos = body.getEnd() - 1
    pending.push({ start: closePos, end: closePos, text: '\nreturn __cordisc_dispose\n' })
  }

  edits.push(...pending)
  return undefined
}

function applyEdits(text: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end)
  let output = text
  for (const edit of sorted) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end)
  }
  return output
}
