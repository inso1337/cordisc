// Microbenchmark: generator effect vs. cordisc-lowered closure effect,
// create + dispose against the real cordis runtime.
import { Context } from 'cordis'

const N = 50_000

function generatorEffect(ctx, sink) {
  return ctx.effect(function* () {
    const a = { open: true }
    yield () => { a.open = false; sink.push(1) }
    const b = { open: true }
    yield () => { b.open = false; sink.push(2) }
    const c = { open: true }
    yield () => { c.open = false; sink.push(3) }
  })
}

// what `cordisc build` emits for the generator above (keep in sync with
// PRELUDE_LINES in src/build.ts, minus the type annotations)
function loweredEffect(ctx, sink) {
  return ctx.effect(function () {
    const __cordisc_inverses = []
    const __cordisc_dispose = () => {
      let __task
      for (let __i = __cordisc_inverses.length - 1; __i >= 0; __i--) {
        const __d = __cordisc_inverses[__i]
        if (__task) __task = __task.then(() => __d())
        else {
          const __r = __d()
          if (__r && typeof __r.then === 'function') __task = __r
        }
      }
      return __task
    }
    const a = { open: true }
    { const __v = () => { a.open = false; sink.push(1) }; if (__v) __cordisc_inverses.push(__v) }
    const b = { open: true }
    { const __v = () => { b.open = false; sink.push(2) }; if (__v) __cordisc_inverses.push(__v) }
    const c = { open: true }
    { const __v = () => { c.open = false; sink.push(3) }; if (__v) __cordisc_inverses.push(__v) }
    return __cordisc_dispose
  })
}

async function run(label, make) {
  const ctx = new Context()
  const sink = []
  // warmup
  for (let i = 0; i < 1_000; i++) await make(ctx, sink)()
  sink.length = 0
  const start = process.hrtime.bigint()
  for (let i = 0; i < N; i++) {
    await make(ctx, sink)()
  }
  const ns = Number(process.hrtime.bigint() - start)
  if (sink.length !== N * 3) throw new Error(`${label}: expected ${N * 3} disposals, saw ${sink.length}`)
  console.log(`${label.padEnd(10)} ${(ns / 1e6).toFixed(1).padStart(8)} ms   ${(ns / N).toFixed(0).padStart(6)} ns/op`)
  return ns
}

const gen = await run('generator', generatorEffect)
const low = await run('lowered', loweredEffect)
console.log(`\nlowered is ${(gen / low).toFixed(2)}x faster (create + dispose, 3 inverses, n=${N})`)
