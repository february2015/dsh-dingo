/**
 * dsh-dingo client — RpcCall 面（/dingo 通道）。
 *
 * @module dsh-dingo/client/rpc
 */

/** `/dingo` RPC 调用器（Connection 注入的调用面）。 */
export interface RpcCall {
  call(channel: string, endpoint: string, payload: unknown): Promise<{
    ok: boolean;
    value?: unknown;
    error?: { code?: string; message?: string; details?: unknown };
  }>;
}
