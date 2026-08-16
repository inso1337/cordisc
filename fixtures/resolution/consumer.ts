import { Context } from 'cordis'
import { CORE_DEPS } from './shared.js'

declare module 'cordis' {
  interface Context {
    database: { query(sql: string): Promise<unknown[]> }
    server: { route(path: string, handler: () => void): void }
    cache: { get(key: string): unknown }
  }
}

export const name = 'resolved-consumer'
// spread of an imported constant — resolved statically
export const inject = [...CORE_DEPS, 'server']

export function apply(ctx: Context) {
  ctx.server.route('/q', () => void ctx.database.query('select 1'))
  // ERROR: cache is not in the (fully resolved) inject list
  ctx.cache.get('q')
}
