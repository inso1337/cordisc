import { Node, ObjectLiteralExpression, SourceFile, SyntaxKind } from 'ts-morph'
import path from 'node:path'
import { Component, Diagnostic, diagnosticAt } from './types.js'

/**
 * Statically evaluate an `inject` expression.
 * Supported shapes (everything else marks the component dynamic):
 *   ['database', 'server']
 *   { database: true, server: { required: false } }
 */
function readInject(node: Node): { keys: Set<string>; dynamic: boolean } {
  const keys = new Set<string>()
  let dynamic = false
  const unwrapped = unwrap(node)
  if (Node.isArrayLiteralExpression(unwrapped)) {
    for (const el of unwrapped.getElements()) {
      const text = stringValue(el)
      if (text === undefined) dynamic = true
      else keys.add(text)
    }
  } else if (Node.isObjectLiteralExpression(unwrapped)) {
    for (const prop of unwrapped.getProperties()) {
      if (Node.isPropertyAssignment(prop) || Node.isShorthandPropertyAssignment(prop)) {
        keys.add(prop.getName().replace(/^['"`]|['"`]$/g, ''))
      } else {
        dynamic = true
      }
    }
  } else {
    dynamic = true
  }
  return { keys, dynamic }
}

function readProvide(node: Node): Set<string> {
  const provides = new Set<string>()
  const unwrapped = unwrap(node)
  if (Node.isArrayLiteralExpression(unwrapped)) {
    for (const el of unwrapped.getElements()) {
      const text = stringValue(el)
      if (text !== undefined) provides.add(text)
    }
  } else {
    const text = stringValue(unwrapped)
    if (text !== undefined) provides.add(text)
  }
  return provides
}

/** Strip `as const`, satisfies, and parentheses. */
function unwrap(node: Node): Node {
  let current = node
  while (
    Node.isAsExpression(current) ||
    Node.isSatisfiesExpression(current) ||
    Node.isParenthesizedExpression(current)
  ) {
    current = current.getExpression()
  }
  return current
}

function stringValue(node: Node): string | undefined {
  const unwrapped = unwrap(node)
  if (Node.isStringLiteral(unwrapped) || Node.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return unwrapped.getLiteralText()
  }
  return undefined
}

function baseName(file: SourceFile): string {
  const base = path.basename(file.getFilePath()).replace(/\.[cm]?tsx?$/, '')
  if (base !== 'index') return base
  return path.basename(path.dirname(file.getFilePath()))
}

/**
 * Discover components in a source file. Recognized shapes:
 *
 *  A. Module-as-component (the Koishi convention):
 *       export const inject = [...]
 *       export function apply(ctx, config) {}
 *  B. Plugin object literal (default export, or argument of ctx.plugin()):
 *       { name, inject, provide, apply(ctx) {} }
 *  C. Class component: exported class with `static inject` and a
 *     constructor(ctx, ...); `extends Service` with super(ctx, 'name')
 *     records a provision.
 *  D. Inline registration: ctx.inject([...], (ctx) => {...})
 */
export function discoverComponents(file: SourceFile, diagnostics: Diagnostic[]): Component[] {
  const components: Component[] = []

  // A: module-level `apply` export
  const applyExport = file.getFunction('apply') ?? file.getVariableDeclaration('apply')
  if (applyExport && isExported(applyExport)) {
    const component = makeComponent(baseName(file), applyExport, bodyOf(applyExport))
    const injectDecl = file.getVariableDeclaration('inject')
    if (injectDecl?.getInitializer()) {
      const { keys, dynamic } = readInject(injectDecl.getInitializer()!)
      component.inject = keys
      component.injectDynamic = dynamic
      if (dynamic) {
        diagnostics.push(diagnosticAt(injectDecl, 'info', 'dynamic-inject',
          `inject of "${component.name}" is not statically analyzable; access checking is disabled for undeclared keys`))
      }
    }
    const provideDecl = file.getVariableDeclaration('provide')
    if (provideDecl?.getInitializer()) {
      component.provides = readProvide(provideDecl.getInitializer()!)
    }
    const nameDecl = file.getVariableDeclaration('name')
    const explicit = nameDecl?.getInitializer() && stringValue(nameDecl.getInitializer()!)
    if (explicit) component.name = explicit
    components.push(component)
  }

  // B: plugin object literals
  for (const obj of file.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
    if (!isPluginObject(obj)) continue
    const applyProp = obj.getProperty('apply')!
    const component = makeComponent(baseName(file), obj, bodyOf(applyProp))
    readObjectMeta(obj, component, diagnostics)
    components.push(component)
  }

  // C: exported classes with constructor(ctx, ...)
  for (const cls of file.getClasses()) {
    if (!isExported(cls)) continue
    const ctor = cls.getConstructors()[0]
    const staticInject = cls.getStaticMember('inject')
    if (!ctor && !staticInject) continue
    const component = makeComponent(cls.getName() ?? baseName(file), cls, [])
    component.className = cls.getName()
    if (ctor) component.bodies.push(ctor)
    for (const method of cls.getInstanceMethods()) component.bodies.push(method)
    if (staticInject && Node.isPropertyDeclaration(staticInject) && staticInject.getInitializer()) {
      const { keys, dynamic } = readInject(staticInject.getInitializer()!)
      component.inject = keys
      component.injectDynamic = dynamic
    }
    // Service subclass: super(ctx, 'name') provides 'name'
    if (ctor) {
      for (const call of ctor.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (call.getExpression().getKind() === SyntaxKind.SuperKeyword) {
          const nameArg = call.getArguments()[1]
          const text = nameArg && stringValue(nameArg)
          if (text) component.provides.add(text)
        }
      }
    }
    if (!ctor && !component.inject.size) continue
    components.push(component)
  }

  // D: ctx.inject([...], callback)
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression()
    if (!Node.isPropertyAccessExpression(expr) || expr.getName() !== 'inject') continue
    const [injectArg, callback] = call.getArguments()
    if (!injectArg || !callback) continue
    if (!Node.isFunctionLikeDeclaration(unwrap(callback))) continue
    const component = makeComponent(`${baseName(file)}#inline`, call, [unwrap(callback)])
    const { keys, dynamic } = readInject(injectArg)
    component.inject = keys
    component.injectDynamic = dynamic
    components.push(component)
  }

  return components
}

function makeComponent(name: string, decl: Node, bodies: Node[]): Component {
  return {
    name,
    file: decl.getSourceFile().getFilePath(),
    decl,
    inject: new Set(),
    injectDynamic: false,
    provides: new Set(),
    bodies,
    used: new Set(),
  }
}

function readObjectMeta(obj: ObjectLiteralExpression, component: Component, diagnostics: Diagnostic[]): void {
  const injectProp = obj.getProperty('inject')
  if (injectProp && Node.isPropertyAssignment(injectProp)) {
    const { keys, dynamic } = readInject(injectProp.getInitializer()!)
    component.inject = keys
    component.injectDynamic = dynamic
    if (dynamic) {
      diagnostics.push(diagnosticAt(injectProp, 'info', 'dynamic-inject',
        `inject of "${component.name}" is not statically analyzable; access checking is disabled for undeclared keys`))
    }
  }
  const provideProp = obj.getProperty('provide')
  if (provideProp && Node.isPropertyAssignment(provideProp)) {
    component.provides = readProvide(provideProp.getInitializer()!)
  }
  const nameProp = obj.getProperty('name')
  if (nameProp && Node.isPropertyAssignment(nameProp)) {
    const text = stringValue(nameProp.getInitializer()!)
    if (text) component.name = text
  }
}

function isPluginObject(obj: ObjectLiteralExpression): boolean {
  const applyProp = obj.getProperty('apply')
  if (!applyProp) return false
  if (!Node.isMethodDeclaration(applyProp) && !Node.isPropertyAssignment(applyProp)) return false
  // require at least one plugin marker beyond `apply` to avoid false positives
  return Boolean(obj.getProperty('inject') ?? obj.getProperty('provide') ?? obj.getProperty('name'))
}

function bodyOf(node: Node): Node[] {
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) return [node]
  if (Node.isPropertyAssignment(node)) {
    const initializer = node.getInitializer()
    return initializer ? [initializer] : []
  }
  if (Node.isVariableDeclaration(node)) {
    const initializer = node.getInitializer()
    return initializer ? [initializer] : []
  }
  return [node]
}

function isExported(node: Node): boolean {
  if (Node.isVariableDeclaration(node)) {
    const statement = node.getFirstAncestorByKind(SyntaxKind.VariableStatement)
    return statement?.isExported() ?? false
  }
  return (node as any).isExported?.() ?? false
}
