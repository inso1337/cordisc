import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../src/analyze.js'

const root = path.dirname(fileURLToPath(import.meta.url))
const appProject = path.join(root, '../fixtures/app/tsconfig.json')
const cleanProject = path.join(root, '../fixtures/clean/tsconfig.json')

describe('cordisc check — fixture app', () => {
  const result = analyze({ project: appProject })
  const codes = result.diagnostics.map((d) => d.code)

  it('discovers all seven components (service classes merged into instantiators)', () => {
    expect(result.components.map((c) => c.name).sort()).toEqual([
      'alpha', 'bad-consumer', 'beta', 'database-plugin', 'good-consumer', 'lazy-plugin', 'server-plugin',
    ])
  })

  it('errors on undeclared coeffect access, including reflective ctx.get()', () => {
    const undeclared = result.diagnostics.filter((d) => d.code === 'undeclared-coeffect')
    expect(undeclared).toHaveLength(2)
    expect(undeclared.map((d) => d.message).join('\n')).toMatch(/"database"/)
    expect(undeclared.map((d) => d.message).join('\n')).toMatch(/"cache"/)
    expect(undeclared.every((d) => d.file.endsWith('bad-consumer.ts'))).toBe(true)
  })

  it('errors on dependency cycles with the cycle path', () => {
    const cycle = result.diagnostics.find((d) => d.code === 'dependency-cycle')
    expect(cycle?.severity).toBe('error')
    expect(cycle?.message).toMatch(/alpha → beta → alpha|beta → alpha → beta/)
  })

  it('warns on declared-but-unused inject keys', () => {
    const unused = result.diagnostics.find((d) => d.code === 'unused-inject')
    expect(unused?.severity).toBe('warning')
    expect(unused?.message).toMatch(/"cache"/)
  })

  it('reports unresolved providers as info, not error', () => {
    const unresolved = result.diagnostics.find((d) => d.code === 'unresolved-provider')
    expect(unresolved?.severity).toBe('info')
  })

  it('does not flag declared accesses or self-provided keys', () => {
    expect(result.diagnostics.filter((d) =>
      d.code === 'undeclared-coeffect' && d.file.endsWith('good-consumer.ts'))).toHaveLength(0)
    expect(result.diagnostics.filter((d) =>
      d.code === 'undeclared-coeffect' && d.file.endsWith('database.ts'))).toHaveLength(0)
  })

  it('attributes a new-ed Service class provision to the instantiating component', () => {
    expect(codes).not.toContain('duplicate-provider')
    const server = result.components.find((c) => c.name === 'server-plugin')
    expect([...server!.provides]).toContain('server')
  })

  it('orders providers before consumers in the load order', () => {
    const order = result.loadOrder
    expect(order.indexOf('database-plugin')).toBeLessThan(order.indexOf('good-consumer'))
    expect(order.indexOf('server-plugin')).toBeLessThan(order.indexOf('good-consumer'))
    // cyclic components are excluded from the order
    expect(order).not.toContain('alpha')
    expect(order).not.toContain('beta')
  })
})

describe('cordisc check — clean subset', () => {
  it('reports zero errors and zero warnings', () => {
    const result = analyze({ project: cleanProject })
    expect(result.diagnostics.filter((d) => d.severity !== 'info')).toEqual([])
    expect(result.loadOrder.at(-1)).toBe('good-consumer')
  })
})
