#!/usr/bin/env node
import { parseArgs } from 'node:util'
import fs from 'node:fs'
import { analyze } from './analyze.js'
import { report } from './report.js'
import { generate } from './gen.js'
import { build } from './build.js'

const HELP = `cordisc — compiler layer for the Cordis context paradigm

Usage:
  cordisc check [files...] -p <tsconfig>   verify coeffect declarations & graph
  cordisc gen -p <tsconfig> [options]      generate Context augmentation + manifest
  cordisc build -p <tsconfig> -o <dir>     lower sync generator effects to closures

Options:
  -p, --project <tsconfig>   tsconfig.json (repeatable for check: merged graph)
  -o, --out <path>           gen: output .d.ts; build: output directory
      --manifest <path>      gen: also write a component manifest (JSON)
      --json                 check: machine-readable output
      --no-color             plain text output
  -h, --help                 show this message

Exit code 1 when any error-severity diagnostic is reported.`

export function main(argv = process.argv.slice(2)): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      project: { type: 'string', short: 'p', multiple: true },
      out: { type: 'string', short: 'o' },
      manifest: { type: 'string' },
      json: { type: 'boolean', default: false },
      color: { type: 'boolean', default: true },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  const [command, ...files] = positionals
  const projects = values.project ?? []

  if (values.help || !command) {
    console.log(HELP)
    return values.help ? 0 : 2
  }

  if (command === 'check') {
    if (!projects.length && !files.length) {
      console.log(HELP)
      return 2
    }
    const result = analyze({ project: projects, files })
    if (values.json) {
      console.log(JSON.stringify({
        components: result.components.map((c) => ({
          name: c.name,
          file: c.file,
          inject: [...c.inject],
          provides: [...c.provides],
        })),
        diagnostics: result.diagnostics,
        loadOrder: result.loadOrder,
      }, null, 2))
    } else {
      console.log(report(result, { color: values.color }))
    }
    return result.diagnostics.some((d) => d.severity === 'error') ? 1 : 0
  }

  if (command === 'gen') {
    if (projects.length !== 1) {
      console.error('gen requires exactly one -p <tsconfig>')
      return 2
    }
    const result = analyze({ project: projects })
    const gen = generate(result.projects[0]!, result)
    if (values.manifest) {
      fs.writeFileSync(values.manifest, JSON.stringify({
        components: result.components.map((c) => ({
          name: c.name,
          file: c.file,
          inject: [...c.inject],
          provides: [...c.provides],
        })),
        loadOrder: result.loadOrder,
      }, null, 2))
      console.error(`manifest → ${values.manifest}`)
    }
    if (!gen.augmentation) {
      console.error(`nothing to generate (${gen.skipped.length} provision(s) already augmented)`)
      return 0
    }
    if (values.out) {
      fs.writeFileSync(values.out, gen.augmentation)
      console.error(`${gen.generated.length} augmentation(s) → ${values.out} (${gen.skipped.length} already declared)`)
    } else {
      console.log(gen.augmentation)
    }
    return 0
  }

  if (command === 'build') {
    if (projects.length !== 1 || !values.out) {
      console.error('build requires -p <tsconfig> and -o <outDir>')
      return 2
    }
    const result = build({ project: projects[0]!, outDir: values.out })
    console.error(`${result.written.length} file(s) → ${values.out}, ${result.lowered} effect(s) lowered`)
    for (const skip of result.skipped) {
      console.error(`  skipped ${skip.file}:${skip.line} — ${skip.reason}`)
    }
    return 0
  }

  console.log(HELP)
  return 2
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main())
}
