import { Node, Project } from 'ts-morph'
import path from 'node:path'
import { AnalysisResult, Component, Diagnostic } from './types.js'
import { discoverComponents } from './discover.js'
import { checkComponent } from './check.js'
import { analyzeGraph } from './graph.js'
import { probeContextType } from './gen.js'

export interface AnalyzeOptions {
  /** One or more tsconfig.json paths — multiple merge into one graph. */
  project?: string | string[]
  /** Explicit file paths/globs, used when no tsconfig is given. */
  files?: string[]
}

export interface AnalyzeOutput extends AnalysisResult {
  /** The underlying ts-morph projects (one per tsconfig), for `gen`. */
  projects: Project[]
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

export function analyze(options: AnalyzeOptions): AnalyzeOutput {
  const projectPaths = typeof options.project === 'string' ? [options.project] : options.project ?? []
  const projects = projectPaths.length
    ? projectPaths.map((p) => new Project({ tsConfigFilePath: p }))
    : [new Project({ compilerOptions: { allowJs: false, strict: false } })]
  if (!projectPaths.length && options.files?.length) {
    projects[0]!.addSourceFilesAtPaths(options.files)
  }

  const diagnostics: Diagnostic[] = []
  const components: Component[] = []

  for (const project of projects) {
    for (const file of project.getSourceFiles()) {
      const filePath = file.getFilePath()
      if (filePath.includes('/node_modules/') || filePath.includes('__cordisc_probe')) continue
      components.push(...discoverComponents(file, diagnostics))
    }
  }

  mergeInstantiatedClasses(components)

  for (const component of components) {
    checkComponent(component, diagnostics)
  }

  // provider hints: when an unresolved key's type is declared by some
  // package's module augmentation, say which one
  const contextTypes = projects
    .map((project) => probeContextType(project, 'cordis'))
    .filter((type) => type !== undefined)
  const hint = (key: string): string | undefined => {
    for (const type of contextTypes) {
      const prop = type.getProperty(key)
      const decl = prop?.getDeclarations()[0]
      if (!decl) continue
      const filePath = decl.getSourceFile().getFilePath()
      const packageMatch = filePath.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)
      if (packageMatch && packageMatch[1] !== 'cordis') {
        return `its type is declared by package "${packageMatch[1]}" — make sure its provider is loaded`
      }
      if (!packageMatch) {
        return `its type is declared in ${path.basename(filePath)} — a provider for it exists somewhere in this codebase`
      }
    }
    return undefined
  }

  const loadOrder = analyzeGraph(components, diagnostics, hint)

  const severityRank = { error: 0, warning: 1, info: 2 } as const
  diagnostics.sort((a, b) =>
    severityRank[a.severity] - severityRank[b.severity] ||
    a.file.localeCompare(b.file) || a.line - b.line)

  return { components, diagnostics, loadOrder, projects }
}
