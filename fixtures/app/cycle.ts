import { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    alpha: unknown
    beta: unknown
  }
}

// ERROR: alpha and beta form a dependency cycle — neither can ever activate
export const alphaPlugin = {
  name: 'alpha',
  inject: ['beta'],
  provide: 'alpha',
  apply(ctx: Context) {
    ctx.set('alpha', { uses: ctx.beta })
  },
}

export const betaPlugin = {
  name: 'beta',
  inject: ['alpha'],
  provide: 'beta',
  apply(ctx: Context) {
    ctx.set('beta', { uses: ctx.alpha })
  },
}
