import { Component, Diagnostic, diagnosticAt } from './types.js'
import { packageRootOf } from './check.js'

/**
 * Build the coeffect dependency graph (edge: consumer → provider), report
 * cycles as errors and unresolved providers as info, and compute a load
 * order for the acyclic part.
 *
 * A cycle means the involved components can never activate (paper §6.5:
 * "a dependency cycle simply leaves the involved components permanently
 * inactive" — predictable from the declarations alone, so we report it
 * at build time).
 */
export function analyzeGraph(
  components: Component[],
  diagnostics: Diagnostic[],
  hint?: (key: string) => string | undefined,
): string[] {
  const providerOf = new Map<string, Component>()
  const isAncestor = (a: Component, b: Component) => {
    for (let current = b.parent; current; current = current.parent) {
      if (current === a) return true
    }
    return false
  }
  for (const component of components) {
    for (const key of component.provides) {
      const existing = providerOf.get(key)
      if (existing && existing !== component) {
        // a nested registration providing its enclosing component's key is
        // the same provision seen twice, not a conflict
        if (isAncestor(existing, component) || isAncestor(component, existing)) continue
        // within one package this is usually two build faces (host/client
        // entry points) that never share a Context at runtime
        const samePackage = packageRootOf(component.file) === packageRootOf(existing.file)
        diagnostics.push(diagnosticAt(component.decl, samePackage ? 'warning' : 'error', 'duplicate-provider',
          samePackage
            ? `"${component.name}" provides "${key}", already provided by "${existing.name}" in the same package — fine if these are separate entry points (host/client faces) that never load into one Context`
            : `"${component.name}" provides "${key}", already provided by "${existing.name}" — provisions must be disjoint (paper Def. 43)`))
        continue
      }
      providerOf.set(key, component)
    }
  }

  const edges = new Map<Component, Set<Component>>()
  for (const component of components) {
    const deps = new Set<Component>()
    for (const key of component.inject) {
      const provider = providerOf.get(key)
      if (!provider) {
        const extra = hint?.(key)
        diagnostics.push(diagnosticAt(component.decl, 'info', 'unresolved-provider',
          `no component in this project provides "${key}" (required by "${component.name}") — it must come from outside, or "${component.name}" stays inactive${extra ? `; ${extra}` : ''}`))
        continue
      }
      if (provider !== component) deps.add(provider)
    }
    edges.set(component, deps)
  }

  // self-dependency: a component that injects a key it provides
  for (const component of components) {
    for (const key of component.inject) {
      if (component.provides.has(key)) {
        diagnostics.push(diagnosticAt(component.decl, 'error', 'self-dependency',
          `"${component.name}" both provides and injects "${key}" — it can never activate (⊀ is not acyclic, paper §4.4.4)`))
      }
    }
  }

  // Tarjan SCC for cycle detection
  const index = new Map<Component, number>()
  const low = new Map<Component, number>()
  const onStack = new Set<Component>()
  const stack: Component[] = []
  const cycles: Component[][] = []
  let counter = 0

  function strongConnect(v: Component): void {
    index.set(v, counter)
    low.set(v, counter)
    counter++
    stack.push(v)
    onStack.add(v)
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        strongConnect(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!))
      }
    }
    if (low.get(v) === index.get(v)) {
      const scc: Component[] = []
      let w: Component
      do {
        w = stack.pop()!
        onStack.delete(w)
        scc.push(w)
      } while (w !== v)
      if (scc.length > 1) cycles.push(scc)
    }
  }

  for (const component of components) {
    if (!index.has(component)) strongConnect(component)
  }

  for (const scc of cycles) {
    const names = scc.map((c) => c.name).reverse()
    diagnostics.push(diagnosticAt(scc[0]!.decl, 'error', 'dependency-cycle',
      `dependency cycle: ${[...names, names[0]].join(' → ')} — these components can never activate (paper §6.5); factor the bidirectional interaction into integration components`))
  }

  // Kahn topological sort over the acyclic part (providers first)
  const cyclic = new Set(cycles.flat())
  const remaining = components.filter((c) => !cyclic.has(c))
  const order: string[] = []
  const pending = new Set(remaining)
  while (pending.size) {
    let progressed = false
    for (const component of [...pending]) {
      const deps = edges.get(component) ?? new Set()
      if ([...deps].every((d) => !pending.has(d))) {
        order.push(component.name)
        pending.delete(component)
        progressed = true
      }
    }
    if (!progressed) break
  }
  return order
}
