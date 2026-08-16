import { Context, Service } from 'cordis'

declare module 'cordis' {
  interface Context {
    database: Database
    cache: Cache
    server: ServerService
  }
}

export interface Database {
  query(sql: string): Promise<unknown[]>
}

export interface Cache {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

export class ServerService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'server')
  }

  route(path: string, handler: () => void) {}
}
