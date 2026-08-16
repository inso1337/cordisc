import { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    flags: { enabled(name: string): boolean }
  }
}

export const name = 'chain-outer'
export const inject = ['server']

export function apply(ctx: Context) {
  // accessor-declared member — resolves through its getter, not inject
  ctx.accessor('flags', { get: () => ({ enabled: () => false }) })
  ctx.inject(['database'], (child) => {
    // child context reads a key the ENCLOSING component declared — legal:
    // cordis resolves along the fiber chain (paper Algorithm 6)
    child.server.route('/chained', () => {
      void child.database.query('select 1')
    })
    // accessor access needs no declaration anywhere
    child.flags.enabled('beta')
  })
}
