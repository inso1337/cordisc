import { Context } from 'cordis'
import { ServerService } from './services.js'

export const name = 'server-plugin'
export const provide = 'server'

export function apply(ctx: Context) {
  new ServerService(ctx)
}
