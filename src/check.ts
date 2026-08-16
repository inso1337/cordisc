import { Node, SyntaxKind, Type } from 'ts-morph'
import { Component, Diagnostic, diagnosticAt } from './types.js'

/**
 * Core member names that exist on Context but are declared with computed or
 * symbol keys the declaration-file heuristic can miss.
 */
const CORE_MEMBERS = new Set(['root', 'baseUrl', 'fiber', 'runtime'])

/** Is this type (or part of it) the Cordis Context? */
function isContextType(type: Type): boolean {
  for (const part of type.isUnion() ? type.getUnionTypes() : [type]) {
    const symbol = part.getSymbol() ?? part.getAliasSymbol()
    if (!symbol) continue
    if (symbol.getName() !== 'Context') continue
    if (symbol.getDeclarations().some((d) => /[/\\]node_modules[/\\](cordis|@cordisjs\b|koishi)\b/.test(d.getSourceFile().getFilePath()) || /[/\\](packages|src)[/\\].*context/.test(d.getSourceFile().getFilePath()))) {
      return true
    }
    // interface merging: any Context symbol with >1 declaration file is
    // almost certainly the augmented cordis Context
    if (symbol.getDeclarations().length > 0) return true
  }
  return false
}

/**
 * Classify a resolved Context property: `builtin` when every declaration
 * lives inside the cordis core (or an ecosystem runtime package), otherwise
 * it is a service key introduced by module augmentation.
 */
function classifyProperty(name: string, contextType: Type): 'builtin' | 'service' | 'unknown' {
  if (CORE_MEMBERS.has(name)) return 'builtin'
  const prop = contextType.getProperty(name)
  if (!prop) return 'unknown'
  const declarations = prop.getDeclarations()
  if (!declarations.length) return 'unknown'
  const allCore = declarations.every((d) =>
    /[/\\]node_modules[/\\](cordis|cosmokit|@cordisjs)[/\\]/.test(d.getSourceFile().getFilePath()))
  return allCore ? 'builtin' : 'service'
}

/**
 * Scan a component's bodies for coeffect accesses and verify each against
 * the component's declarations. Records used keys on the component.
 */
export function checkComponent(component: Component, diagnostics: Diagnostic[]): void {
  for (const body of component.bodies) {
    body.forEachDescendant((node) => {
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
      // ctx.get('key') / ctx.set('key', v) / ctx.provide('key')
      if (Node.isCallExpression(node)) {
        const callee = node.getExpression()
        if (!Node.isPropertyAccessExpression(callee)) return
        const method = callee.getName()
        if (!['get', 'set', 'provide', 'accessor'].includes(method)) return
        if (!isContextType(callee.getExpression().getType())) return
        const keyArg = node.getArguments()[0]
        if (!keyArg || !Node.isStringLiteral(keyArg)) return
        const key = keyArg.getLiteralText()
        if (method === 'get') {
          markServiceUse(component, node, key, diagnostics)
        } else {
          // set/provide/accessor install a binding — record the provision
          component.provides.add(key)
        }
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
  const kind = classifyProperty(name, contextType)
  if (kind === 'builtin') return
  if (kind === 'unknown') {
    diagnostics.push(diagnosticAt(node, 'warning', 'unknown-context-member',
      `"${component.name}" accesses ctx.${name}, which is declared neither by cordis nor by any module augmentation`))
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
