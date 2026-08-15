/**
 * `/dingo` RPC 通道：client ↔ host，JSON POST，loopback 权威。
 *
 * | endpoint | 用途 |
 * |----------|------|
 * | feedback | 插播队列快照 / 关闭 / 重播 / 播完上报 / 打断 / 上报当前会话 |
 * | set-current-session | 客户端上报"当前查看的对话"（叮/叮叮 判定用） |
 * | switch | 卡片点击跳转：按 sessionId 解析所属工作区并返回（client 打开） |
 *
 * 复用自 dsh-localvoice（/voice 通道），本地 TTS/ASR 全部移除。
 *
 * @module dsh-dingo/rpc
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ChannelAuthority } from './types.ts';
import type { FeedbackEngine, FeedbackSnapshot } from './feedback.ts';

/** RPC 校验/业务错误。 */
export class RpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** `/dingo` RPC 通道依赖。 */
export interface DingoRpcDeps {
  /** 插播反馈引擎（提醒队列/提示音/卡片数据源）。 */
  readonly feedback: FeedbackEngine;
  /** 设置"当前查看会话"（客户端上报；广播/引擎 own 判定用）。 */
  readonly setCurrentSessionId?: (id: string | undefined) => void;
  /** 会话跳转网关（缺省从 ctx.apiProxy 懒取）。 */
  readonly apiProxy?: unknown;
}

/** 注册 `/dingo` RPC 通道（可逆 effect；unload 时自动卸载）。 */
export function installDingoRpc(ctx: Context, deps: DingoRpcDeps, authority: ChannelAuthority): void {
  ctx.effect(() => ctx.connection.rpc.handle('/dingo', async (endpoint, payload, signal) => {
    if (signal.aborted) {
      return { ok: false, error: { code: 'cancelled', message: 'request cancelled', details: {} } };
    }
    try {
      switch (endpoint) {
        case 'feedback': {
          return handleFeedbackEndpoint(deps.feedback, payload);
        }
        case 'set-current-session': {
          // 客户端上报"当前查看的对话"：当前对话回复 → 叮/叮叮（soft 档），
          // 其他对话 → 另一声音（crisp 档）+ 卡片；own 判定也用它。
          const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
          const sid = typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : undefined;
          deps.setCurrentSessionId?.(sid);
          return { ok: true, value: { current: sid ?? null } };
        }
        case 'switch': {
          // 卡片点击跳转：按 sessionId 解析所属工作区并返回（client 侧打开对应会话）。
          const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
          const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
          if (sessionId === '') throw new RpcError('bad-request', 'switch 需要 sessionId');
          const api = deps.apiProxy ?? (ctx as unknown as { apiProxy?: unknown }).apiProxy;
          const result = await resolveSessionWorkspace(api, sessionId);
          return { ok: true, value: result };
        }
        default:
          return {
            ok: false,
            error: { code: 'internal', message: `unknown /dingo endpoint: ${endpoint}`, details: {} },
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: { code: 'internal', message, details: {} } };
    }
  }, { authority }), 'dsh-dingo: /dingo channel');
}

/* ──────────────────────────────────────────────────────────────────────
 * /dingo.feedback（提醒队列客户端通道）
 * ────────────────────────────────────────────────────────────────────── */

/** `/dingo.feedback` 请求。 */
export interface FeedbackRpcRequest {
  readonly action:
    | 'announcements'
    | 'dismiss'
    | 'replay'
    | 'spoken'
    | 'interrupt'
    | 'set-active-session';
  readonly id?: string;
  readonly sessionId?: string;
}

/** 处理 `/dingo.feedback`（引擎已存在）。 */
function handleFeedbackEndpoint(engine: FeedbackEngine, payload: unknown): { ok: true; value: unknown } {
  const request = validateFeedbackPayload(payload);
  switch (request.action) {
    case 'announcements': {
      const snapshot: FeedbackSnapshot = engine.snapshot();
      return { ok: true, value: snapshot };
    }
    case 'dismiss':
      return { ok: true, value: { ok: engine.dismiss(request.id ?? '') } };
    case 'replay':
      return { ok: true, value: { ok: engine.replay(request.id ?? '') } };
    case 'spoken':
      // 客户端播完上报 → 引擎播下一条
      engine.completeSpeech(request.id);
      return { ok: true, value: { ok: true } };
    case 'interrupt':
      // 用户打断 → 停止当前插播，队列保留
      engine.interruptCurrent();
      return { ok: true, value: { ok: true } };
    case 'set-active-session':
      engine.setActiveSession(request.sessionId);
      return { ok: true, value: { ok: true } };
  }
}

/** 校验 `/dingo.feedback` 请求形状。 */
function validateFeedbackPayload(payload: unknown): FeedbackRpcRequest {
  if (typeof payload !== 'object' || payload === null) {
    throw new RpcError('bad-request', 'feedback 请求必须是对象');
  }
  const record = payload as Record<string, unknown>;
  const action = record.action;
  const known = new Set<FeedbackRpcRequest['action']>(['announcements', 'dismiss', 'replay', 'spoken', 'interrupt', 'set-active-session']);
  if (typeof action !== 'string' || !known.has(action as FeedbackRpcRequest['action'])) {
    throw new RpcError('bad-request', `action 非法：${String(action)}（支持 announcements/dismiss/replay/spoken/interrupt/set-active-session）`);
  }
  if (record.id !== undefined && typeof record.id !== 'string') {
    throw new RpcError('bad-request', 'id 必须是字符串');
  }
  if (record.sessionId !== undefined && typeof record.sessionId !== 'string') {
    throw new RpcError('bad-request', 'sessionId 必须是字符串');
  }
  return {
    action: action as FeedbackRpcRequest['action'],
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
  };
}

/* ──────────────────────────────────────────────────────────────────────
 * /dingo.switch（卡片跳转：sessionId → 所属工作区）
 * ────────────────────────────────────────────────────────────────────── */

/** 宿主 apiProxy.workspace.list 的最小形状。 */
interface WorkspaceListApi {
  list(request: { rpcId: unknown; payload: Record<string, never> }): Promise<{
    result: {
      ok: boolean;
      value?: { items?: readonly { workspaceId: string; title: string; sessionIds?: readonly string[] }[] };
    };
  }>;
}

/** 解析 sessionId 所属工作区（卡片跳转目标）。 */
async function resolveSessionWorkspace(api: unknown, sessionId: string): Promise<{
  action: 'enter-session';
  sessionId: string;
  workspace?: { workspaceId: string; title: string };
}> {
  const proxy = api as { workspace?: WorkspaceListApi } | undefined;
  if (proxy?.workspace?.list) {
    try {
      const response = await proxy.workspace.list({ rpcId: mintRpcId(), payload: {} });
      if (response.result.ok) {
        const ws = (response.result.value?.items ?? []).find((w) => w.sessionIds?.includes(sessionId));
        if (ws) {
          return { action: 'enter-session', sessionId, workspace: { workspaceId: ws.workspaceId, title: ws.title } };
        }
      }
    } catch {
      // 宿主清单不可用 → 仍返回 sessionId（client 可尝试直接打开）
    }
  }
  return { action: 'enter-session', sessionId };
}

/** 生成一次宿主 RPC 调用 id。 */
function mintRpcId(): unknown {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
