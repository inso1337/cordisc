import { Context } from 'cordis'

export function setup(ctx: Context) {
  // inline registration — discovered as a component of its own
  ctx.inject(['server'], (inner) => {
    inner.server.route('/health', () => {})
    // ERROR: database is not in the inline inject list
    void inner.database.query('select 1')
  })
}
