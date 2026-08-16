import path from 'node:path'
import { AnalysisResult, Severity } from './types.js'

const COLORS: Record<Severity, string> = { error: '\x1b[31m', warning: '\x1b[33m', info: '\x1b[36m' }
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'

export function report(result: AnalysisResult, options: { color?: boolean; cwd?: string } = {}): string {
  const { color = true, cwd = process.cwd() } = options
  const paint = (severity: Severity, text: string) => (color ? `${COLORS[severity]}${text}${RESET}` : text)
  const bold = (text: string) => (color ? `${BOLD}${text}${RESET}` : text)
  const lines: string[] = []

  lines.push(bold(`${result.components.length} component(s) discovered`))
  for (const component of result.components) {
    const inject = component.inject.size ? ` inject[${[...component.inject].join(', ')}]` : ''
    const provides = component.provides.size ? ` provide[${[...component.provides].join(', ')}]` : ''
    lines.push(`  • ${component.name}${inject}${provides}  (${path.relative(cwd, component.file)})`)
  }

  if (result.diagnostics.length) {
    lines.push('')
    for (const d of result.diagnostics) {
      const location = `${path.relative(cwd, d.file)}:${d.line}:${d.column}`
      lines.push(`${paint(d.severity, d.severity.padEnd(7))} ${d.code.padEnd(24)} ${location}`)
      lines.push(`        ${d.message}`)
    }
  }

  if (result.loadOrder.length) {
    lines.push('')
    lines.push(bold('load order (providers first):') + ' ' + result.loadOrder.join(' → '))
  }

  const errors = result.diagnostics.filter((d) => d.severity === 'error').length
  const warnings = result.diagnostics.filter((d) => d.severity === 'warning').length
  lines.push('')
  lines.push(errors
    ? paint('error', `✗ ${errors} error(s), ${warnings} warning(s)`)
    : paint('info', `✓ no errors, ${warnings} warning(s)`))
  return lines.join('\n')
}
