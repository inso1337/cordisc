import { Node, SyntaxKind, Type } from 'ts-morph'
import fs from 'node:fs'
import path from 'node:path'
import { Component, Diagnostic, diagnosticAt } from './types.js'

/** Is this type (or part of it) a Cordis Context? Structural, not nominal:
 * named `Context` and carrying the two members every Cordis context has. */
export function isContextType(type: Type): boolean {
  for (const part of type.isUnion() ? type.getUnionTypes() : [type]) {
    const symbol = part.getSymbol() ?? part.getAliasSymbol()
    if (!symbol || symbol.getName() !== 'Context') continue
    if (part.getProperty('extend') && part.getProperty('plugin')) return true
  }
  return false
}

const packageRootCache = new Map<string, string>()

/** Nearest ancestor directory containing a package.json. */
export function packageRootOf(filePath: string): string {
  const dir = path.dirname(filePath)
  const cached = packageRootCache.get(dir)
  if (cached) return cached
  let current = dir
  while (true) {
    if (fs.existsSync(path.join(current, 'package.json'))) break
    const parent = path.dirname(current)
    if (parent === current) {
      current = dir
      break
    }
    current = parent
  }
  packageRootCache.set(dir, current)
  return current
}

/**
 * The "home" package roots of a Context type: the packages declaring the
 * Context symbol itself and its base types. Everything declared there is
 * framework API; everything declared elsewhere is a service key introduced
 * by module augmentation. This is rename-proof and fork-proof — it works
 * identically for `cordis`, a vendored `@deepseek-ai/cordis`, or a
 * downstream Context subclass (whose own package joins the home set).
 */
export function getContextHomes(type: Type, seen = new Set<string>()): Set<string> {
  const homes = new Set<string>()
  const symbol = type.getSymbol() ?? type.getAliasSymbol()
  if (!symbol) return homes
  const key = symbol.getFullyQualifiedName()
  if (seen.has(key)) return homes
  seen.add(key)
  // Context is a merged symbol: its declarations include every user
  // augmentation. The home is where the *class* is declared — falling back
  // to all declarations only when no class exists (interface-only mocks).
  const declarations = symbol.getDeclarations()
  const classDeclarations = declarations.filter((d) => Node.isClassDeclaration(d))
  for (const decl of classDeclarations.length ? classDeclarations : declarations) {
    homes.add(packageRootOf(decl.getSourceFile().getFilePath()))
  }
  for (const base of type.getBaseTypes()) {
    for (const home of getContextHomes(base, seen)) homes.add(home)
  }
  return homes
}

/**
 * Classify a resolved Context property: `builtin` when every declaration
 * lives inside a home package of the Context type itself, otherwise it is
 * a service key introduced by module augmentation.
 */
function classifyProperty(name: string, contextType: Type): 'builtin' | 'service' | 'unknown' {
  const prop = contextType.getProperty(name)
  if (!prop) return 'unknown'
  const declarations = prop.getDeclarations()
  if (!declarations.length) return 'unknown'
  const homes = getContextHomes(contextType)
  if (!homes.size) return 'unknown'
  const allCore = declarations.every((d) => homes.has(packageRootOf(d.getSourceFile().getFilePath())))
  return allCore ? 'builtin' : 'service'
}

/**
 * Scan a component's bodies for coeffect accesses and verify each against
 * the component's declarations. Records used keys on the component.
 */
export function checkComponent(component: Component, diagnostics: Diagnostic[], allComponents: Component[] = []): void {
  // regions owned by other components nested inside this one (e.g. an
  // inline ctx.inject registration inside a Service method) are theirs to
  // check — walking into them would double-attribute every access
  const foreignRanges = allComponents
    .filter((other) => other !== component && other.file === component.file)
    .map((other) => ({ start: other.decl.getStart(), end: other.decl.getEnd() }))
    .filter((range) => component.bodies.some((body) => range.start >= body.getStart() && range.end <= body.getEnd()))
  const isForeign = (node: Node) =>
    foreignRanges.some((range) => node.getStart() >= range.start && node.getEnd() <= range.end)

  // pre-pass: collect ctx.provide() registrations, so an access earlier in
  // document order than the provide call still counts as self-provided
  for (const body of component.bodies) {
    body.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return
      const callee = node.getExpression()
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'provide') return
      if (!isContextType(callee.getExpression().getType())) return
      const keyArg = node.getArguments()[0]
      if (keyArg && Node.isStringLiteral(keyArg)) component.provides.add(keyArg.getLiteralText())
    })
  }

  for (const body of component.bodies) {
    body.forEachDescendant((node, traversal) => {
      if (isForeign(node)) {
        traversal.skip()
        return
      }
      // ctx.foo  /  ctx['foo']
      if (Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node)) {
        const expr = node.getExpression()
        let name: string | undefined
        if (Node.isPropertyAccessExpression(node)) {
          name = node.getName()
        } else {
          const arg = node.getArgumentExpression()
          if (arg && Node.isStringLiteral(arg)) name = arg.getLiteralText()
        }
        if (!name) return
        const exprType = expr.getType()
        if (!isContextType(exprType)) return
        verifyAccess(component, node, name, exprType, diagnostics)
        return
      }
      // reflective operations with a string-literal key:
      //   get(key)          → usage, checked like ctx[key]
      //   set(key, value)   → a write to an existing binding — usage, not
      //                       a provision (setting an unprovided key throws
      //                       at runtime in cordis v4)
      //   provide(key, …)   → the actual registration — a provision
      //   accessor(key, …)  → a forwarding declaration — neither
      if (Node.isCallExpression(node)) {
        const callee = node.getExpression()
        if (!Node.isPropertyAccessExpression(callee)) return
        const method = callee.getName()
        if (!['get', 'set'].includes(method)) return
        if (!isContextType(callee.getExpression().getType())) return
        const keyArg = node.getArguments()[0]
        if (!keyArg || !Node.isStringLiteral(keyArg)) return
        markServiceUse(component, node, keyArg.getLiteralText(), diagnostics)
      }
    })
  }

  for (const key of component.inject) {
    if (!component.used.has(key)) {
      diagnostics.push(diagnosticAt(component.decl, 'warning', 'unused-inject',
        `"${component.name}" declares inject "${key}" but never accesses it`))
    }
  }
}

function verifyAccess(component: Component, node: Node, name: string, contextType: Type, diagnostics: Diagnostic[]): void {
  // a declared or self-provided key is a service access even when its
  // augmentation is not part of the analyzed file set (partial analysis
  // of a larger project must not flag declared usage)
  if (component.inject.has(name) || component.provides.has(name)) {
    component.used.add(name)
    return
  }
  const kind = classifyProperty(name, contextType)
  if (kind === 'builtin') return
  if (kind === 'unknown') {
    diagnostics.push(diagnosticAt(node, 'warning', 'unknown-context-member',
      `"${component.name}" accesses ctx.${name}, which is declared neither by the Context's own package nor by any module augmentation`))
    return
  }
  markServiceUse(component, node, name, diagnostics)
}

function markServiceUse(component: Component, node: Node, key: string, diagnostics: Diagnostic[]): void {
  if (component.provides.has(key)) {
    component.used.add(key)
    return
  }
  if (component.inject.has(key)) {
    component.used.add(key)
    return
  }
  if (component.injectDynamic) return
  diagnostics.push(diagnosticAt(node, 'error', 'undeclared-coeffect',
    `"${component.name}" accesses service "${key}" without declaring it — add "${key}" to inject (paper §5.1.4: undeclared access fails at runtime)`))
}
