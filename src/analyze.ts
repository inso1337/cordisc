import { Node, Project, SourceFile } from 'ts-morph'
import path from 'node:path'
import { AnalysisResult, Component, Diagnostic } from './types.js'
import { discoverComponents } from './discover.js'
import { checkComponent, getContextHomes } from './check.js'
import { analyzeGraph } from './graph.js'
import { probeContextType } from './gen.js'

export interface AnalyzeOptions {
  /** One or more tsconfig.json paths — multiple merge into one graph. */
  project?: string | string[]
  /** Explicit file paths/globs, used when no tsconfig is given. */
  files?: string[]
  /** Module specifier declaring Context (auto-detected when omitted). */
  contextModule?: string
}

export interface AnalyzeOutput extends AnalysisResult {
  /** The underlying ts-morph projects (one per tsconfig), for `gen`. */
  projects: Project[]
  /** The module specifier Context was imported from (e.g. 'cordis'). */
  contextModule: string
}

/**
 * Detect the module specifier the project imports Context from: `cordis`
 * upstream, `@deepseek-ai/cordis` in DeepSeek Harness, `koishi` in Koishi
 * plugins. Majority vote over non-relative `import { Context } from '…'`
 * declarations; relative imports are framework-internal and ignored.
 */
function detectContextModule(files: SourceFile[]): string | undefined {
  const votes = new Map<string, number>()
  for (const file of files) {
    for (const decl of file.getImportDeclarations()) {
      const specifier = decl.getModuleSpecifierValue()
      if (specifier.startsWith('.')) continue
      if (!decl.getNamedImports().some((n) => n.getName() === 'Context')) continue
      votes.set(specifier, (votes.get(specifier) ?? 0) + 1)
    }
  }
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
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

  const allFiles = projects.flatMap((project) => project.getSourceFiles())
    .filter((file) => !file.getFilePath().includes('/node_modules/') && !file.getFilePath().includes('__cordisc_probe'))

  const contextModule = options.contextModule ?? detectContextModule(allFiles) ?? 'cordis'

  // the framework's own source (a vendored or path-mapped Context package)
  // is not a set of user components — resolve the Context type's home
  // package roots and skip files living inside them
  const contextTypes = projects
    .map((project) => probeContextType(project, contextModule))
    .filter((type) => type !== undefined)
  const homeRoots = new Set<string>()
  for (const type of contextTypes) {
    for (const home of getContextHomes(type)) homeRoots.add(home)
  }
  const insideHome = (filePath: string) =>
    [...homeRoots].some((root) => filePath.startsWith(root + '/'))

  for (const file of allFiles) {
    if (insideHome(file.getFilePath())) continue
    components.push(...discoverComponents(file, diagnostics))
  }

  mergeInstantiatedClasses(components)

  for (const component of components) {
    checkComponent(component, diagnostics, components)
  }
  const hint = (key: string): string | undefined => {
    for (const type of contextTypes) {
      const prop = type.getProperty(key)
      const decl = prop?.getDeclarations()[0]
      if (!decl) continue
      const filePath = decl.getSourceFile().getFilePath()
      const packageMatch = filePath.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)
      if (packageMatch && packageMatch[1] !== contextModule) {
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

  return { components, diagnostics, loadOrder, projects, contextModule }
}
