import { Node, Project } from 'ts-morph'
import { AnalysisResult, Component, Diagnostic } from './types.js'
import { discoverComponents } from './discover.js'
import { checkComponent } from './check.js'
import { analyzeGraph } from './graph.js'

export interface AnalyzeOptions {
  /** Path to a tsconfig.json — preferred, gives full type resolution. */
  project?: string
  /** Explicit file paths/globs, used when no tsconfig is given. */
  files?: string[]
}

/**
 * A class component that another component instantiates (`new X(ctx)`) is
 * that component's implementation detail, not an independent graph node:
 * its provisions are attributed to the instantiator and the class is
 * dropped from the component list.
 */
function mergeInstantiatedClasses(components: Component[]): void {
  const byClassName = new Map<string, Component>()
  for (const component of components) {
    if (component.className) byClassName.set(component.className, component)
  }
  if (!byClassName.size) return
  const absorbed = new Set<Component>()
  for (const component of components) {
    for (const body of component.bodies) {
      body.forEachDescendant((node) => {
        if (!Node.isNewExpression(node)) return
        const callee = node.getExpression()
        const name = Node.isIdentifier(callee) ? callee.getText() : undefined
        const target = name ? byClassName.get(name) : undefined
        if (!target || target === component) return
        for (const key of target.provides) component.provides.add(key)
        absorbed.add(target)
      })
    }
  }
  for (const component of absorbed) {
    components.splice(components.indexOf(component), 1)
  }
}

export function analyze(options: AnalyzeOptions): AnalysisResult {
  const project = options.project
    ? new Project({ tsConfigFilePath: options.project })
    : new Project({ compilerOptions: { allowJs: false, strict: false } })
  if (!options.project && options.files?.length) {
    project.addSourceFilesAtPaths(options.files)
  }

  const diagnostics: Diagnostic[] = []
  const components: Component[] = []

  for (const file of project.getSourceFiles()) {
    if (file.getFilePath().includes('/node_modules/')) continue
    components.push(...discoverComponents(file, diagnostics))
  }

  mergeInstantiatedClasses(components)

  for (const component of components) {
    checkComponent(component, diagnostics)
  }

  const loadOrder = analyzeGraph(components, diagnostics)

  const severityRank = { error: 0, warning: 1, info: 2 } as const
  diagnostics.sort((a, b) =>
    severityRank[a.severity] - severityRank[b.severity] ||
    a.file.localeCompare(b.file) || a.line - b.line)

  return { components, diagnostics, loadOrder }
}
