import { Context } from 'cordis'
import type { Database } from './services.js'

export const name = 'database-plugin'
export const provide = 'database'

export function apply(ctx: Context) {
  const db: Database = { query: async () => [] }
  ctx.provide('database', db)
}
