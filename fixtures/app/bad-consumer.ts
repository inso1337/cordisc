import { Context } from 'cordis'

export const name = 'bad-consumer'
export const inject = ['server']

export function apply(ctx: Context) {
  ctx.server.route('/stats', () => {
    // ERROR: accesses `database` without declaring it
    void ctx.database.query('select count(*) from events')
    // ERROR: reflective access is checked too
    ctx.get('cache')
  })
}
