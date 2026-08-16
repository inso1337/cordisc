#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { analyze } from './analyze.js'
import { report } from './report.js'

const HELP = `cordisc — compiler layer for the Cordis context paradigm

Usage:
  cordisc check [files...] [options]

Options:
  -p, --project <tsconfig>   analyze the project described by a tsconfig.json
      --json                 machine-readable output
      --no-color             plain text output
  -h, --help                 show this message

Exit code 1 when any error-severity diagnostic is reported.`

export function main(argv = process.argv.slice(2)): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      project: { type: 'string', short: 'p' },
      json: { type: 'boolean', default: false },
      color: { type: 'boolean', default: true },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  const [command, ...files] = positionals
  if (values.help || command !== 'check' || (!values.project && !files.length)) {
    console.log(HELP)
    return values.help ? 0 : 2
  }

  const result = analyze({ project: values.project, files })

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

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main())
}
