/**
 * 自注册的 `/dingo` RPC 通道（插件内实现，不依赖 `connection.rpc.handle`）。
 *
 * 为什么自己实现：本版 DSH 的 `connection.rpc.handle` 内部会把 `owner.webServer`
 * 经 traceable shadow 锚定到 connection 服务自己的 fiber，那个 fiber 永远解析不到
 * 兄弟 `webServer` 服务 —— 任何消费方调用都抛
 * `cannot get property "webServer" without inject`（与消费方 inject 声明无关）。
 *
 * 做法（与 dsh-feishu-pilot / dsh-webhook-github 同款）：插件自己用
 * `ctx.webServer.register({ kind:'prefix', path:'/dingo' })` 注册前缀路由，
 * 路由内手工复刻 dsh-client-connection 的线上协议，客户端 `connection.rpc.call`
 * 无需任何改动：
 *
 * - `POST /dingo/<endpoint>`，`content-type: application/json`
 * - 请求体 `{ type:'client-request', rpcId, method, payload }`，method 必须等于 endpoint
 * - 响应 `{ type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error} }`
 *
 * @module dsh-dingo/rpc-route
 */
import type { Context } from '@deepseek-ai/cordis';
import { safeService } from './feedback.ts';

/** 端点结果（线上信封里的 result 字段）。 */
export type RpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: Record<string, unknown> } };

/** 端点处理：返回 {@link RpcResult}。 */
export type RpcEndpointHandler = (endpoint: string, payload: unknown) => Promise<RpcResult> | RpcResult;

/** endpoint 段允许的字符集（对齐 dsh-client-connection 的 endpointFromPath）。 */
const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/;

/** 请求体上限（字节）：/dingo 的入参都是小 JSON，超过即拒，防内存被撑爆。 */
const MAX_BODY_BYTES = 1_048_576;

/** 请求体超限（与"读流失败"区分，前者回 413）。 */
class BodyTooLargeError extends Error {
  constructor() {
    super(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/** 从 pathname 解出相对 channel 的 endpoint；非法段返回 undefined。 */
function endpointOf(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined;
  const endpoint = pathname.slice(channel.length + 1);
  if (endpoint.split('/').some((seg) => seg === '' || seg === '.' || seg === '..' || !ENDPOINT_SEGMENT.test(seg))) {
    return undefined;
  }
  return endpoint;
}

/** 读取 node:http 请求体（带字节上限）。 */
function readBody(req: { on(event: string, listener: (...args: unknown[]) => void): unknown }): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 把内部结果规范成线上格式（失败时 error 必须带 details 对象）。 */
function toWireResult(result: RpcResult): unknown {
  if (result.ok !== false) return result;
  const error = result.error;
  if (typeof error === 'string') {
    return { ...result, error: { code: 'plugin/error', message: String(error), details: {} } };
  }
  if (error && typeof error === 'object' && error.details === undefined) {
    return { ...result, error: { ...error, details: {} } };
  }
  return result;
}

/** 最小化的 req/res 形状（webServer 前缀路由参数）。 */
interface RouteRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

interface RouteResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(body?: string | Buffer): unknown;
}

/**
 * 注册一个 RPC 前缀通道。
 *
 * `webServer` 不是硬依赖：没有 Web 载体的宿主（headless / sdk）只跳过 RPC，
 * 提示音、卡片、命令等其余能力照常工作。所以这里不写进静态 `inject`，而是用
 * 动态 `ctx.inject` 等服务就绪再挂（服务已在则回调立即执行，不会抢跑、也不会重复挂）。
 * @param ctx - 宿主上下文。
 * @param channel - 通道前缀，如 `/dingo`。
 * @param handler - 端点处理。
 * @param label - effect 标签（卸载时用于日志）。
 */
export function registerRpcChannel(ctx: Context, channel: string, handler: RpcEndpointHandler, label: string): void {
  const inject = (ctx as unknown as {
    inject?: (deps: string[], callback: (scope: Context) => void) => unknown;
  }).inject;
  if (typeof inject !== 'function') return;
  inject.call(ctx, ['webServer'], (scope) => {
    const server = safeService<WebServerLike>(scope, 'webServer');
    if (!server?.register) return;
    const route = createRoute(scope, channel, handler);
    scope.effect(() => server.register(route), label);
  });
}

/** webServer 的最小形状（插件不依赖它的类型包）。 */
interface WebServerLike {
  register(route: unknown): () => void;
}

/** 组装前缀路由（校验/信封/错误码都在这里）。 */
function createRoute(ctx: Context, channel: string, handler: RpcEndpointHandler): unknown {
  const connection = safeService<{ requestRejection?: (req: unknown) => number | undefined }>(ctx, 'connection');
  const reject = typeof connection?.requestRejection === 'function'
    ? (req: unknown): number | undefined => connection.requestRejection!(req)
    : undefined;

  const sendJson = (res: RouteResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(Buffer.from(JSON.stringify(body)));
  };

  return {
    kind: 'prefix' as const,
    path: channel,
    handler: async (req: RouteRequest, res: RouteResponse): Promise<void> => {
      const rejection = reject ? reject(req) : undefined;
      if (rejection !== undefined) {
        res.writeHead(rejection);
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      const endpoint = endpointOf(channel, pathname);
      if (endpoint === undefined) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') {
        res.writeHead(415);
        res.end('content type must be application/json');
        return;
      }
      let raw: string;
      try {
        raw = await readBody(req);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          res.writeHead(413);
          res.end('body too large');
          return;
        }
        res.writeHead(400);
        res.end('body read failed');
        return;
      }
      let body: { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        res.writeHead(400);
        res.end('body is not JSON');
        return;
      }
      const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : 'invalid-request';
      if (body?.type !== 'client-request' || typeof body?.rpcId !== 'string' || typeof body?.method !== 'string') {
        sendJson(res, 200, {
          type: 'server-response',
          rpcId,
          result: { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: {} } },
        });
        return;
      }
      if (body.method !== endpoint) {
        sendJson(res, 200, {
          type: 'server-response',
          rpcId,
          result: {
            ok: false,
            error: { code: 'gateway/bad-request', message: `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`, details: {} },
          },
        });
        return;
      }
      let result: RpcResult;
      try {
        result = await handler(endpoint, body.payload);
      } catch (error) {
        res.writeHead(500);
        res.end(`handler failure: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      sendJson(res, 200, { type: 'server-response', rpcId: body.rpcId, result: toWireResult(result) });
    },
  };
}
