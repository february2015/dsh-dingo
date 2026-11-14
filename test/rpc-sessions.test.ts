/**
 * `/dingo.sessions` 端点：客户端（尤其窄屏浮层）拿会话清单补卡。
 */
import { describe, expect, it } from 'vitest'
import { installDingoRpc } from '../src/rpc.ts'

interface Route {
  handler: (req: unknown, res: unknown) => Promise<void>
}

interface Captured {
  status?: number
  body?: string
}

/** 最小 node:http 请求。 */
function fakeReq(payload: string): unknown {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const req = {
    method: 'POST',
    url: '/dingo/sessions',
    headers: { 'content-type': 'application/json' },
    on(event: string, listener: (...args: unknown[]) => void): unknown {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      if (event === 'end') {
        queueMicrotask(() => {
          for (const fn of listeners.get('data') ?? []) fn(Buffer.from(payload))
          for (const fn of listeners.get('end') ?? []) fn()
        })
      }
      return req
    },
  }
  return req
}

/** 最小 node:http 响应。 */
function fakeRes(captured: Captured): unknown {
  return {
    writeHead(status: number): unknown {
      captured.status = status
      return this
    },
    end(body?: string | Buffer): unknown {
      captured.body = body === undefined ? '' : String(body)
      return this
    },
  }
}

/** 组装假宿主 ctx 并注册 RPC 通道，返回捕获到的路由。 */
function setup(deps: Parameters<typeof installDingoRpc>[1]): { route: () => Route } {
  let captured: Route | undefined
  const webServer = {
    register(candidate: unknown): () => void {
      captured = candidate as Route
      return () => { captured = undefined }
    },
  }
  const ctx = {
    get: (name: string) => (name === 'webServer' ? webServer : undefined),
    inject: (_deps: string[], callback: (scope: unknown) => void) => callback(ctx),
    effect: (fn: () => unknown) => fn(),
  }
  installDingoRpc(ctx as never, deps)
  return {
    route: () => {
      if (captured === undefined) throw new Error('route not registered')
      return captured
    },
  }
}

const body = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'sessions', payload: {} })

describe('/dingo.sessions', () => {
  it('返回 listSessions 给出的清单', async () => {
    const { route } = setup({
      feedback: {} as never,
      listSessions: async () => [
        { sessionId: 's1', title: '会话一', running: true, cwd: '/tmp/a' },
        { sessionId: 's2', title: undefined, running: false },
      ],
    })
    const response: Captured = {}
    await route().handler(fakeReq(body), fakeRes(response))
    expect(response.status).toBe(200)
    const parsed = JSON.parse(String(response.body)) as { result: { ok: boolean; value: { items: unknown[] } } }
    expect(parsed.result.ok).toBe(true)
    expect(parsed.result.value.items).toHaveLength(2)
    expect(parsed.result.value.items[0]).toMatchObject({ sessionId: 's1', title: '会话一', running: true })
  })

  it('宿主不提供清单时返回空数组（旧宿主不报错）', async () => {
    const { route } = setup({ feedback: {} as never })
    const response: Captured = {}
    await route().handler(fakeReq(body), fakeRes(response))
    const parsed = JSON.parse(String(response.body)) as { result: { ok: boolean; value: { items: unknown[] } } }
    expect(parsed.result.ok).toBe(true)
    expect(parsed.result.value.items).toEqual([])
  })

  it('listSessions 抛错时信封内报错而不是 500 崩溃', async () => {
    const { route } = setup({
      feedback: {} as never,
      listSessions: async () => { throw new Error('boom') },
    })
    const response: Captured = {}
    await route().handler(fakeReq(body), fakeRes(response))
    expect(response.status).toBe(200)
    const parsed = JSON.parse(String(response.body)) as { result: { ok: boolean; error?: { message: string } } }
    expect(parsed.result.ok).toBe(false)
    expect(parsed.result.error?.message).toContain('boom')
  })
})
