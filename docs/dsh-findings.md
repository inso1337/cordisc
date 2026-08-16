# Coeffect analysis of DeepSeek Harness — findings report

*Produced by [`cordisc check`](https://github.com/inso1337/cordisc) (static coeffect checker for Cordis) run over the full `deepseek-ai/deepseek-harness` monorepo: 1185 source files across `packages/*/*/src`, 548 discovered components, analyzed against the vendored `@deepseek-ai/cordis` via the repo's own path mappings — no build required.*

*This report is drafted for an upstream discussion; nothing has been filed yet.*

## Headline

The codebase is remarkably clean under the paper's own discipline: across 548 components there are **zero hard undeclared-coeffect errors** (accesses that would throw at runtime) and a fully acyclic dependency graph with a valid provider-first load order. What the analysis does surface is one systemic *pattern* worth an upstream conversation, one modeling observation, and a large tail of gate-only inject declarations.

## Finding 1 — 44 undeclared soft reads: optional dependencies invisible to the coeffect system

44 call sites use `ctx.get('key')` for a service the component never declares, distributed over these keys:

| key | soft reads | | key | soft reads |
|---|---|---|---|---|
| `agents` | 8 | | `credentials` | 2 |
| `sessions` | 6 | | `codeRuntime` | 2 |
| `jobs` | 4 | | `apiProxy` | 2 |
| `sessionPersistence` | 3 | | `workspaces` | 1 |
| `approval` | 3 | | `userQuestions` | 1 |
| `sandboxPolicy` | 2 | | `subagents` | 1 |

Representative example (`packages/core/agent-loop/src/index.ts`):

```ts
const persistence = this.runtime.ctx.get('sessionPersistence')
if (persistence === undefined) {
  throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
}
```

These are deliberate optional-dependency reads with explicit undefined handling — not bugs. But they trade away the two things the coeffect system provides:

1. **Visibility**: the dependency appears in no `inject`, so an orchestrator (or `cordisc gen --manifest`) cannot see that agent-loop can use persistence.
2. **Reactivity**: `ctx.get` is a one-shot read. When a persistence backend loads *after* the reading component activated, nothing re-evaluates — e.g. agents configured with `sessionId` before the backend arrives have already taken the no-persistence path, silently and permanently.

Cordis has a first-class alternative: optional inject (`inject: { sessionPersistence: { required: false } }`), which keeps activation ungated while making the dependency visible and the component reactive to the provider's arrival. If the one-shot semantics are intentional in some of these 44 sites, that's a fine choice — but plausibly not in all of them, and the `agents`/`sessions`/`jobs` clusters suggest a convention rather than 44 case-by-case decisions.

**Suggested upstream question:** is there an intended policy for when a dsh component should use optional inject vs. a bare `ctx.get`? If yes, documenting it (and migrating the sites that violate it) would make the dependency graph honest; if no, this is the data to design one from.

## Finding 2 — 227 gate-only inject declarations

227 declared inject keys are never accessed in their component's own body (e.g. `AgentLoop` declares `llm` and `tools` but touches them only through the machinery it spawns). This is a legitimate Cordis idiom — inject-as-activation-gate — but at this volume it is indistinguishable from stale declarations by inspection. A lightweight convention (comment tag, or a wrapper like `gates: [...]` merged into inject) would let both humans and tools tell "gate" from "leftover."

## Finding 3 — host/client faces of one key

`dynamicCordisRunner` is provided by both `cordis-host-runner` (a Service subclass) and `cordis-client-runner` (`ctx.provide` in the client face). Correct at runtime — the two faces never share a Context — but it means any whole-monorepo dependency analysis needs partition information that currently exists only implicitly in the build setup. A machine-readable face/entry-point marker (even a package.json field) would make the composition analyzable per-runtime.

## Method note

All classification is symbol-origin-based against the vendored fork (no hardcoded package names), inline `ctx.inject` registrations are checked with fiber-chain declaration resolution matching the runtime's own walk, and `ctx.accessor` members are exempt from declaration checking. False positives found during this analysis were fixed in the tool rather than reported here; what remains above survived that filter.
