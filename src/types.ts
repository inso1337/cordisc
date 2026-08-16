import type { Node, SourceFile } from 'ts-morph'

/** A discovered Cordis component (the paper's ⟨d, p, e⟩ triple, statically). */
export interface Component {
  /** Display name: explicit `name` export/field, else file basename. */
  name: string
  file: string
  /** Node whose position identifies the component in diagnostics. */
  decl: Node
  /** Declared coeffect keys (the `d` of the paper). */
  inject: Set<string>
  /** `true` when the inject expression could not be statically evaluated. */
  injectDynamic: boolean
  /** Declared/observed provisions (the `p` of the paper). */
  provides: Set<string>
  /** Body nodes to scan for context accesses. */
  bodies: Node[]
  /** Inject keys that were actually accessed (for unused-inject reporting). */
  used: Set<string>
  /** Set for class components: the class name, used to attribute `new X(ctx)`. */
  className?: string
}

export type Severity = 'error' | 'warning' | 'info'

export interface Diagnostic {
  severity: Severity
  code: string
  message: string
  file: string
  line: number
  column: number
}

export interface AnalysisResult {
  components: Component[]
  diagnostics: Diagnostic[]
  /** Topological load order (component names), when the graph is acyclic. */
  loadOrder: string[]
}

export function diagnosticAt(node: Node, severity: Severity, code: string, message: string): Diagnostic {
  const file = node.getSourceFile()
  const { line, column } = file.getLineAndColumnAtPos(node.getStart())
  return { severity, code, message, file: file.getFilePath(), line, column }
}

export function fileDiagnostic(file: SourceFile, severity: Severity, code: string, message: string): Diagnostic {
  return { severity, code, message, file: file.getFilePath(), line: 1, column: 1 }
}
