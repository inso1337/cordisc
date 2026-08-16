import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../src/analyze.js'
import { generate } from '../src/gen.js'
import { build } from '../src/build.js'

const root = path.dirname(fileURLToPath(import.meta.url))
const fixture = (...parts: string[]) => path.join(root, '../fixtures', ...parts)

describe('inject resolution (imported constants, spreads)', () => {
  const result = analyze({ project: fixture('resolution/tsconfig.json') })

  it('resolves spread of a cross-file imported const', () => {
    const consumer = result.components.find((c) => c.name === 'resolved-consumer')!
    expect([...consumer.inject].sort()).toEqual(['database', 'server'])
    expect(consumer.injectDynamic).toBe(false)
  })

  it('still catches undeclared access after resolution', () => {
    const undeclared = result.diagnostics.filter(
      (d) => d.code === 'undeclared-coeffect' && d.file.endsWith('consumer.ts'))
    expect(undeclared).toHaveLength(1)
    expect(undeclared[0]!.message).toMatch(/"cache"/)
  })

  it('discovers inline ctx.inject registrations and checks them', () => {
    const inline = result.components.find((c) => c.name === 'inline#inline')
    expect(inline).toBeDefined()
    expect([...inline!.inject]).toEqual(['server'])
    const undeclared = result.diagnostics.filter(
      (d) => d.code === 'undeclared-coeffect' && d.file.endsWith('inline.ts'))
    expect(undeclared).toHaveLength(1)
    expect(undeclared[0]!.message).toMatch(/"database"/)
  })
})

describe('cordisc gen', () => {
  const result = analyze({ project: fixture('gen/tsconfig.json') })
  const gen = generate(result.projects[0]!, result)

  it('generates an augmentation for unaugmented provisions, with the inferred type', () => {
    expect(gen.generated).toHaveLength(1)
    expect(gen.generated[0]!.key).toBe('metrics')
    expect(gen.generated[0]!.type).toMatch(/hits: number/)
    expect(gen.augmentation).toContain("declare module 'cordis'")
    expect(gen.augmentation).toContain('interface Context')
  })

  it('skips provisions that already have a hand-written augmentation', () => {
    const app = analyze({ project: fixture('app/tsconfig.json') })
    const appGen = generate(app.projects[0]!, app)
    // database/server/cache are declared in services.ts — nothing to generate for them
    expect(appGen.skipped).toEqual(expect.arrayContaining(['database', 'server']))
    expect(appGen.generated.map((g) => g.key)).not.toContain('database')
  })
})

describe('cross-package analysis', () => {
  it('merges multiple tsconfigs into one graph', () => {
    const result = analyze({
      project: [fixture('app/tsconfig.json'), fixture('resolution/tsconfig.json')],
    })
    const names = result.components.map((c) => c.name)
    expect(names).toContain('good-consumer')
    expect(names).toContain('resolved-consumer')
    // the app's database-plugin now resolves resolved-consumer's inject
    const order = result.loadOrder
    expect(order.indexOf('database-plugin')).toBeLessThan(order.indexOf('resolved-consumer'))
  })

  it('hints at the augmentation origin for unresolved providers', () => {
    const result = analyze({ project: fixture('app/tsconfig.json') })
    const unresolved = result.diagnostics.find((d) => d.code === 'unresolved-provider')
    expect(unresolved?.message).toMatch(/declared in services\.ts/)
  })
})

describe('cordisc build — sync generator lowering', () => {
  const outDir = fixture('build/.out')
  fs.rmSync(outDir, { recursive: true, force: true })
  const result = build({ project: fixture('build/tsconfig.json'), outDir })
  const loweredPath = path.join(outDir, 'effects.ts')
  const loweredText = fs.readFileSync(loweredPath, 'utf8')

  it('lowers the sync generators and reports the yield* bail', () => {
    expect(result.lowered).toBe(2)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]!.reason).toMatch(/yield\*/)
  })

  it('removes the generator machinery from lowered effects', () => {
    // registerAsync keeps its async generator; registerDelegate keeps yield*
    const syncGenerators = loweredText.match(/(?<!async )function\* \(/g) ?? []
    expect(syncGenerators).toHaveLength(1) // only the yield* bail survives
    expect(loweredText).toContain('async function*')
    expect(loweredText).toContain('__cordisc_dispose')
  })

  it('behaves identically to the original against the real cordis runtime', async () => {
    const { Context } = await import('cordis')
    const original = await import(fixture('build/effects.ts'))
    const lowered = await import(loweredPath)

    for (const n of [0, 1, 3]) {
      const logA: string[] = []
      const logB: string[] = []
      const ctxA = new Context()
      const ctxB = new Context()
      const disposeA = original.register(ctxA, logA, n)
      const disposeB = lowered.register(ctxB, logB, n)
      await disposeA()
      await disposeB()
      expect(logB).toEqual(logA)
      expect(logA.length).toBeGreaterThan(0)
    }

    for (const skip of [true, false]) {
      const logA: string[] = []
      const logB: string[] = []
      const disposeA = original.registerEarly(new Context(), logA, skip)
      const disposeB = lowered.registerEarly(new Context(), logB, skip)
      await disposeA()
      await disposeB()
      expect(logB).toEqual(logA)
    }

    // the bailed yield* effect still works via the untouched original path
    const logDelegate: string[] = []
    const disposeDelegate = lowered.registerDelegate(new Context(), logDelegate)
    await disposeDelegate()
    expect(logDelegate).toEqual(['undo:inner'])
  })

  it('disposes in LIFO order (newest inverse first)', async () => {
    const { Context } = await import('cordis')
    const log: string[] = []
    const dispose = (await import(loweredPath)).register(new Context(), log, 2)
    await dispose()
    expect(log).toEqual(['setup:start', 'setup:end', 'undo:final', 'undo:conditional', 'undo:1', 'undo:0'])
  })
})
