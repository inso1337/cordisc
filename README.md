# cordisc

A compiler layer for the [Cordis](https://github.com/cordiverse/cordis) context paradigm — ordinary TypeScript plus a build step, the way JSX and Svelte added their semantics to existing ecosystems.

The [Cordis paper](https://github.com/cordiverse/paper) (§5.1.4) notes that undeclared dependency access "is in principle detectable at compile time, by resolving each `ctx[key]` against the declared `d` before execution," and (§6.5) that dependency cycles are "predictable from the dependency declarations alone." Today both surface at runtime. `cordisc` moves them to the build — and moves two runtime costs there with them.

```bash
npm install -D cordisc

cordisc check -p tsconfig.json           # verify coeffect declarations & graph
cordisc gen   -p tsconfig.json -o ctx.d.ts   # generate Context augmentation + manifest
cordisc build -p tsconfig.json -o dist-lowered  # lower sync generator effects
```

## `cordisc check` — static coeffect verification

| code | severity | meaning |
|---|---|---|
| `undeclared-coeffect` | error | `ctx.foo` (or `ctx.set('foo', …)`) where `foo` is a service key not in the component's `inject` and not self-provided — throws at runtime |
| `undeclared-optional-coeffect` | warning | undeclared `ctx.get('foo')` — the sanctioned soft access, but the dependency is invisible to the orchestrator and non-reactive; declare `{ foo: { required: false } }` |
| `dependency-cycle` | error | components whose inject/provide graph is cyclic — they can never activate (paper §6.5) |
| `self-dependency` | error | a component that injects a key it provides |
| `duplicate-provider` | error / warning | two components providing the same key (provisions must be disjoint, paper Def. 43) — downgraded to warning within one package (usually host/client build faces), suppressed for a nested registration of its enclosing component's key |
| `unused-inject` | warning | declared but never accessed inject key |
| `unknown-context-member` | warning | `ctx.foo` declared neither by cordis nor by any module augmentation |
| `unresolved-provider` | info | injected key no component in the project provides — with a hint naming the package or file whose augmentation declares it |
| `dynamic-inject` | info | inject expression not statically analyzable; checking degrades gracefully |

Also prints a provider-first **load order** for the acyclic part of the graph. `--json` for tooling; exit code 1 on errors — wire it into CI next to `tsc`.

**Cross-package analysis**: pass `-p` multiple times to merge several tsconfigs (a monorepo's packages) into one graph — providers in one package resolve consumers in another.

**Inject evaluation** follows imported constants and spreads (`[...CORE_DEPS, 'server']`, including cross-file `const` definitions) before giving up and degrading to `dynamic-inject`.

### How service keys are told apart from core API

The cordis `Context` type grows by module augmentation: framework members are declared by the package that declares the `Context` class itself, while every service key is declared by some other package's `declare module '…' { interface Context { … } }`. `cordisc` resolves each `ctx.foo` through the TypeScript type checker and classifies the property by **symbol origin**: builtin when its declaration lives in a home package of the Context type (the class's own package, plus base-class packages), service otherwise. No annotations, no config, no hardcoded package names — it works identically for upstream `cordis`, a vendored fork like DeepSeek Harness's `@deepseek-ai/cordis` (resolved via `paths` to `vendor/cordis/src`), or a downstream Context subclass like Koishi's. The module specifier Context is imported from is auto-detected (majority vote over imports) and overridable with `--module`.

Validated against real code: running `check` over DeepSeek Harness's `system-prompt`, `agent-loop`, and `session` packages produces zero false errors on framework API and surfaces genuine undeclared-access candidates.

### Recognized component shapes

- module-as-component (`export const inject = […]; export function apply(ctx) {}` — the Koishi convention), with `provide`/`name` exports
- plugin object literals (`{ name, inject, provide, apply }`)
- class components (`static inject`, or a `Service` base class — `super(ctx, 'key')` records the provision; a class `new`-ed inside another component is folded into it; plain classes that merely take a `ctx` are *not* treated as components)
- inline `ctx.inject([…], (ctx) => {…})` — checked as a component of its own, excluded from its enclosing component's scan, and resolving declarations **along the component chain** (a child context may read any key an enclosing component declared, exactly as the runtime's fiber-chain walk permits)
- `ctx.accessor(…)`-declared members are exempt from declaration checking (they resolve through their own getter, not inject gating)
- `ctx.provide('key', …)` records a provision; `ctx.set('key', …)` is a *write* to an existing binding and is checked as usage (matching cordis v4, where set-without-provide throws); `ctx.accessor` is neither

## `cordisc gen` — augmentation & manifest generation

For every provision that lacks a hand-written module augmentation, `gen` emits one, inferring the key's type from the value passed to `ctx.set(key, value)` (or the `Service` subclass instance type):

```ts
// generated by cordisc gen — do not edit
declare module 'cordis' {
  interface Context {
    /** provided by metrics-plugin */
    metrics: { hits: number; record(event: string): void }
  }
}
```

`--manifest out.json` additionally writes the component graph (names, inject, provides, load order) as JSON — input for loaders, docs, or dashboards. Provisions that already have an augmentation are skipped, so `gen` is idempotent alongside hand-written declarations.

## `cordisc build` — effect state-machine lowering

A **synchronous** generator passed to `ctx.effect()` cannot be interrupted between yields — the runtime drains it in one tick, so its iteration boundaries are unobservable (the paper's L-Divert can only fall at a boundary an `await` opens). `build` therefore fuses such generators into a single closure that accumulates inverses in a local array and returns one LIFO disposer — eliminating the generator object, the iterator protocol, and per-step runtime tracking, with identical semantics:

```ts
// before                                   // after
ctx.effect(function* () {                   ctx.effect(function () {
  const s = listen(port)                      const __inv = [], __dispose = /* LIFO chain */
  yield () => s.close()                       const s = listen(port)
  const t = setInterval(tick, 1e3)            __inv.push(() => s.close())
  yield () => clearInterval(t)                const t = setInterval(tick, 1e3)
})                                            __inv.push(() => clearInterval(t))
                                              return __dispose
                                            })
```

Guarantees:

- **semantics-preserving or untouched** — `yield*`, yields used as expression values, and async generators (which have *real* boundaries for partial rollback) are left intact and reported, never half-transformed;
- **verified against the real runtime** — the test suite runs original and lowered effects against `cordis` itself and asserts identical disposal logs, including early returns, loops, conditionals, and LIFO order;
- **measured**: ~1.4× faster create+dispose in a 3-inverse microbenchmark against cordis 4.0.0-rc.8 (`node scripts/bench.mjs`; 1.40–1.49× across runs on an M-series laptop — rerun it yourself rather than trusting a README);
- **exercised on real code**: lowers DeepSeek Harness's production generator effects, including the `function* (this: Service) {…}.bind(this)` idiom.

## Programmatic API

```ts
import { analyze, generate, build, report } from 'cordisc'

const result = analyze({ project: ['a/tsconfig.json', 'b/tsconfig.json'] })
result.diagnostics  // typed, sorted by severity
result.loadOrder    // providers first
```

## Development

```bash
npm install
npm test          # builds (pretest) then runs vitest
node dist/cli.js check -p fixtures/app/tsconfig.json
node scripts/bench.mjs
```

Each feature area has a small Cordis fixture project under `fixtures/` that triggers everything the feature detects or transforms. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Non-goals (for now)

- analyzing *compiled* published plugins (needs `.d.ts`-level discovery; the multi-tsconfig mode covers monorepos today)
- lowering async generator effects (their boundaries are load-bearing: partial rollback happens there)
- checking that a supplied inverse actually inverts its effect (a semantic property; see the paper's §6.1 on the system boundary)

## License

MIT
