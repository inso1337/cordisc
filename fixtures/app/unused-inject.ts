import { Context } from 'cordis'

export const name = 'lazy-plugin'
// WARNING: declares `cache` but never touches it
export const inject = ['cache', 'database']

export function apply(ctx: Context) {
  void ctx.database.query('select 1')
}
