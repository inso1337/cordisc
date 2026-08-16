# Contributing to cordisc

Thanks for your interest!

## Setup

```bash
npm install
npm run build     # tsc → dist/
npm test          # vitest (builds first via pretest)
```

## Project layout

- `src/discover.ts` — component discovery (module / object / class / inline shapes)
- `src/check.ts` — coeffect access checking via the TypeScript type checker
- `src/graph.ts` — inject/provide graph, cycle detection, load order
- `src/gen.ts` — Context augmentation + manifest generation
- `src/build.ts` — sync-generator effect lowering
- `fixtures/` — one small Cordis project per feature area; tests assert against them

## Guidelines

- Every diagnostic needs a fixture that triggers it and a test that asserts it.
- `cordisc build` transformations must come with a semantic-equivalence test
  that runs both the original and the lowered code against the real `cordis`
  runtime (see `test/roadmap.test.ts`) — never a snapshot-only test.
- When a transform can't preserve semantics, bail and report; never emit
  best-effort code.
- Diagnostics should cite the relevant section of the
  [Cordis paper](https://github.com/cordiverse/paper) where one applies.

## Releasing

CI must be green. `npm pack --dry-run` should list only `dist/`, `README.md`,
and `LICENSE`.
