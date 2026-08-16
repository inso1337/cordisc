import { Context } from 'cordis'

export const name = 'metrics-plugin'
export const provide = 'metrics'

export function apply(ctx: Context) {
  ctx.set('metrics', {
    hits: 0,
    record(event: string) {
      this.hits += 1
    },
  })
}
