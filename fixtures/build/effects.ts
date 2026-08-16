import { Context } from 'cordis'

/** Sync generator with loop + conditional + trailing return — lowered. */
export function register(ctx: Context, log: string[], n: number) {
  return ctx.effect(function* () {
    log.push('setup:start')
    for (let i = 0; i < n; i++) {
      const idx = i
      yield () => log.push(`undo:${idx}`)
    }
    if (n > 1) {
      yield () => log.push('undo:conditional')
    }
    log.push('setup:end')
    return () => log.push('undo:final')
  })
}

/** Early bare return — lowered. */
export function registerEarly(ctx: Context, log: string[], skip: boolean) {
  return ctx.effect(function* () {
    yield () => log.push('undo:a')
    if (skip) return
    yield () => log.push('undo:b')
  })
}

/** yield* delegation — not lowerable, must be skipped and left intact. */
export function registerDelegate(ctx: Context, log: string[]) {
  function* inner() {
    yield () => log.push('undo:inner')
  }
  return ctx.effect(function* () {
    yield* inner()
  })
}

/** Bound generator with a typed this — the Service-method idiom; lowered. */
export function registerBound(ctx: Context, log: string[]) {
  const runtime = { tag: 'bound' }
  return ctx.effect(function* (this: { tag: string }) {
    const tag = this.tag
    yield () => log.push(`undo:${tag}`)
    yield () => log.push(`undo:${this.tag}-2`)
  }.bind(runtime))
}

/** Async generator — real iteration boundaries, deliberately untouched. */
export function registerAsync(ctx: Context, log: string[]) {
  return ctx.effect(async function* () {
    yield () => log.push('undo:async')
  })
}
