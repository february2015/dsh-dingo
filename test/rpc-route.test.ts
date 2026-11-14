/**
 * 自注册 RPC 通道路由测试（rpc-route.ts）：
 * 信封校验、鉴权转调、请求体上限、webServer 缺席时的静默降级。
 */
import { describe, expect, it } from 'vitest'
import { registerRpcChannel } from '../src/rpc-route.ts'

interface Captured {
  status?: number
  body?: string
}

interface FakeReqOptions {
  method?: string
  url?: string
  contentType?: string
  rejection?: number
}

interface Route {
  handler: (req: unknown, res: unknown) => Promise<void>
}

/** 最小 node:http 请求：注册 end 时把 data/end 依次派发。 */
function fakeReq(payload: string, options: FakeReqOptions = {}): unknown {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const req = {
    method: options.method ?? 'POST',
    url: options.url ?? '/dingo/feedback',
    headers: { 'content-type': options.contentType ?? 'application/json' },
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

/** 最小 node:http 响应：记录状态与响应体。 */
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

/**
 * 组装假宿主 ctx 并捕获注册进来的路由。
 * @param options.hasWebServer - false 时模拟无 Web 载体的宿主。
 * @param options.rejection - connection.requestRejection 的返回值（模拟未授权）。
 */
function setup(options: { hasWebServer?: boolean; rejection?: number } = {}): {
  ctx: unknown
  route: () => Route
} {
  let captured: Route | undefined
  const webServer = {
    register(candidate: unknown): () => void {
      captured = candidate as Route
      return () => { captured = undefined }
    },
  }
  const connection = options.rejection === undefined
    ? undefined
    : { requestRejection: () => options.rejection }
  const ctx = {
    get: (name: string) => {
      if (name === 'webServer') return options.hasWebServer === false ? undefined : webServer
      if (name === 'connection') return connection
      return undefined
    },
    inject: (_deps: string[], callback: (scope: unknown) => void) => callback(ctx),
    effect: (fn: () => unknown) => fn(),
  }
  return {
    ctx,
    route: () => {
      if (captured === undefined) throw new Error('route not registered')
      return captured
    },
  }
}

const validBody = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'feedback', payload: {} })

/** 跑一次请求，返回捕获到的响应。 */
async function request(
  payload: string,
  options: FakeReqOptions = {},
  setupOptions: Parameters<typeof setup>[0] = {},
): Promise<Captured> {
  const { ctx, route } = setup(setupOptions)
  registerRpcChannel(ctx as never, '/dingo', async () => ({ ok: true, value: { hello: 1 } }), 'test')
  const response: Captured = {}
  await route().handler(fakeReq(payload, options), fakeRes(response))
  return response
}

describe('registerRpcChannel', () => {
  it('合法信封 → 200 + handler 结果', async () => {
    const response = await request(validBody)
    expect(response.status).toBe(200)
    expect(JSON.parse(String(response.body))).toEqual({
      type: 'server-response',
      rpcId: 'r1',
      result: { ok: true, value: { hello: 1 } },
    })
  })

  it('缺少 webServer → 静默跳过，不抛错', () => {
    const { ctx, route } = setup({ hasWebServer: false })
    expect(() => registerRpcChannel(ctx as never, '/dingo', async () => ({ ok: true, value: null }), 'test')).not.toThrow()
    expect(() => route()).toThrow()
  })

  it('connection.requestRejection 拒了 → 401 unauthorized', async () => {
    const response = await request(validBody, {}, { rejection: 401 })
    expect(response.status).toBe(401)
    expect(response.body).toBe('unauthorized')
  })

  it('GET → 404', async () => {
    const response = await request('', { method: 'GET' })
    expect(response.status).toBe(404)
  })

  it('非法 endpoint 段 → 404', async () => {
    const response = await request(validBody, { url: '/dingo/../etc/passwd' })
    expect(response.status).toBe(404)
  })

  it('非 application/json → 415', async () => {
    const response = await request(validBody, { contentType: 'text/plain' })
    expect(response.status).toBe(415)
  })

  it('请求体不是 JSON → 400', async () => {
    const response = await request('not json')
    expect(response.status).toBe(400)
    expect(response.body).toBe('body is not JSON')
  })

  it('请求体超过 1MB → 413', async () => {
    const response = await request(`{"pad":"${'x'.repeat(1_100_000)}"}`)
    expect(response.status).toBe(413)
  })

  it('method 与 endpoint 不一致 → 200 信封内报 gateway/bad-request', async () => {
    const response = await request(JSON.stringify({ type: 'client-request', rpcId: 'r9', method: 'other', payload: {} }))
    expect(response.status).toBe(200)
    const parsed = JSON.parse(String(response.body)) as { result: { ok: boolean } }
    expect(parsed.result.ok).toBe(false)
  })
})
