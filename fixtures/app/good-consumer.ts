import { Context } from 'cordis'

export const name = 'good-consumer'
export const inject = ['database', 'server']

export function apply(ctx: Context) {
  ctx.server.route('/users', () => {
    void ctx.database.query('select * from users')
  })
}
