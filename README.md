# cordisc

A compiler layer for the [Cordis](https://github.com/cordiverse/cordis) context paradigm — ordinary TypeScript plus a build step, the way JSX and Svelte added their semantics to existing ecosystems.

The [Cordis paper](https://github.com/cordiverse/paper) (§5.1.4) notes that undeclared dependency access "is in principle detectable at compile time, by resolving each `ctx[key]` against the declared `d` before execution," and (§6.5) that dependency cycles are "predictable from the dependency declarations alone." Today both surface at runtime. `cordisc` moves them to the build.

## v0: `cordisc check`

Static analysis of a Cordis project:

| code | severity | meaning |
|---|---|---|
| `undeclared-coeffect` | error | `ctx.foo` (or `ctx.get('foo')`) where `foo` is a service key not in the component's `inject` and not self-provided |
| `dependency-cycle` | error | components whose inject/provide graph is cyclic — they can never activate (paper §6.5) |
| `self-dependency` | error | a component that injects a key it provides |
| `duplicate-provider` | error | two components providing the same key (provisions must be disjoint, paper Def. 43) |
| `unused-inject` | warning | declared but never accessed inject key |
| `unknown-context-member` | warning | `ctx.foo` declared neither by cordis nor by any module augmentation |
| `unresolved-provider` | info | injected key no component in the project provides (may come from outside) |
| `dynamic-inject` | info | inject expression not statically analyzable; checking degrades gracefully |

It also prints a provider-first **load order** for the acyclic part of the graph.

```bash
cordisc check -p tsconfig.json          # analyze a project
cordisc check src/plugins/*.ts          # analyze specific files
cordisc check -p tsconfig.json --json   # machine-readable output
```

Exit code 1 when any error-severity diagnostic fires — wire it into CI next to `tsc`.

### How service keys are told apart from core API

The cordis `Context` type grows by module augmentation: core members are declared inside `node_modules/cordis`, while every service key is declared by some other package's `declare module 'cordis' { interface Context { … } }`. `cordisc` resolves each `ctx.foo` through the TypeScript type checker and classifies the property by where its declaration lives. No annotations, no config: the augmentation you already write for type safety *is* the coeffect declaration.

### Recognized component shapes

- module-as-component (`export const inject = […]; export function apply(ctx) {}` — the Koishi convention), with `provide`/`name` exports
- plugin object literals (`{ name, inject, provide, apply }`)
- class components (`static inject`, `constructor(ctx)`), including `Service` subclasses (`super(ctx, 'key')` records the provision; a class `new`-ed inside another component is folded into it)
- inline `ctx.inject([…], (ctx) => {…})`
- `ctx.set('key', …)` / `ctx.provide('key')` observed in a body are recorded as provisions

## Roadmap

- **`cordisc gen`** — generate module augmentation and typed accessors from provide declarations (kill the runtime Proxy for compile-resolved keys)
- **`cordisc build`** — lower effect iterators into single state machines with inverse slots (the closure-per-effect allocation goes away)
- richer inject evaluation (imported constants, spreads)
- cross-package analysis for published plugin ecosystems

## Development

```bash
npm install
npm run build     # tsc → dist/
npm test          # vitest
node dist/cli.js check -p fixtures/app/tsconfig.json
```

`fixtures/app` is a small Cordis application with one of everything the checker detects.
