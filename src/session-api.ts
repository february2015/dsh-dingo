/**
 * 会话 API 适配层（host 侧）：写标题 / 读最近事件。
 *
 * DSH 0.2 起宿主的 `ctx.apiProxy` 已被拆掉，会话能力改由 `sessionController`
 * 提供（`rename` / `events` / `list` 都是它的 @Remote 方法，宿主内可直接调）。
 * 但 0.1.x 仍可能在跑，所以这里统一成"新 API 优先、旧 apiProxy 兜底"。
 *
 * 调用全部带超时：按钮点击是用户可感知的操作，宿主某次 RPC 卡住时不能永久转圈。
 *
 * @module dsh-dingo/session-api
 */
import type { Context } from '@deepseek-ai/cordis'
import { safeService } from './feedback.ts'

/** 一次宿主调用的超时（ms）。 */
const CALL_TIMEOUT_MS = 15_000

/** 历史条目（新旧形状一致：`{ event: { type, data } }`）。 */
export interface HistoryEntryLike {
  event?: { type?: string; data?: Record<string, unknown>; [key: string]: unknown }
}

/** 写标题结果。 */
export interface RenameResult {
  ok: boolean
  title?: string
  error?: string
}

/** 读历史结果。 */
export interface HistoryResult {
  ok: boolean
  entries: readonly HistoryEntryLike[]
  error?: string
}

/** 0.2+ `sessionController` 的最小形状。 */
interface ModernSessionsLike {
  rename?(request: { sessionId: string; title: string }): Promise<{ title?: string }>
  events?(
    request: { address: { kind: 'session'; sessionId: string }; maxMessages?: number },
    signal?: AbortSignal,
  ): Promise<{ records?: readonly HistoryEntryLike[] }>
}

/** 0.1.x `apiProxy.sessions` 的最小形状。 */
interface LegacySessionsLike {
  history(request: {
    rpcId: unknown
    payload: { sessionId: string; maxMessages?: number }
  }): Promise<{
    result: { ok: boolean; value?: { events?: readonly HistoryEntryLike[] }; error?: { message?: string } }
  }>
  rename(request: {
    rpcId: unknown
    payload: { sessionId: string; title: string }
  }): Promise<{
    result: { ok: boolean; value?: { title: string }; error?: { message?: string } }
  }>
}

/** 错误 → 文案。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 带超时的信号（无 AbortSignal.timeout 时退化为不超时）。 */
function callSignal(): AbortSignal | undefined {
  return typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(CALL_TIMEOUT_MS) : undefined
}

/** 0.2+ 的会话服务（缺席 = 旧宿主）。 */
function modernSessions(ctx: Context): ModernSessionsLike | undefined {
  return safeService<ModernSessionsLike>(ctx, 'sessionController')
}

/** 0.1.x 的 apiProxy.sessions（缺席 = 新宿主）。 */
function legacySessions(ctx: Context): LegacySessionsLike | undefined {
  return safeService<{ sessions?: LegacySessionsLike }>(ctx, 'apiProxy')?.sessions
}

/** 写会话标题：0.2 的 `sessionController.rename` 优先，旧 `apiProxy.sessions.rename` 兜底。 */
export async function renameSessionTitle(ctx: Context, sessionId: string, title: string): Promise<RenameResult> {
  const modern = modernSessions(ctx)
  if (typeof modern?.rename === 'function') {
    try {
      const value = await modern.rename({ sessionId, title })
      return { ok: true, title: value?.title ?? title }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  const legacy = legacySessions(ctx)
  if (typeof legacy?.rename === 'function') {
    try {
      const response = await legacy.rename({ rpcId: makeRpcId(), payload: { sessionId, title } })
      if (!response.result.ok) return { ok: false, error: response.result.error?.message ?? '写入标题失败' }
      return { ok: true, title: response.result.value?.title ?? title }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  return { ok: false, error: '重命名不可用：宿主既没有 sessionController.rename，也没有 apiProxy.sessions' }
}

/** 读会话最近事件（默认最近 50 条消息）：0.2 的 `events` 优先，旧 `history` 兜底。 */
export async function readRecentHistory(ctx: Context, sessionId: string, maxMessages = 50): Promise<HistoryResult> {
  const modern = modernSessions(ctx)
  if (typeof modern?.events === 'function') {
    try {
      const page = await modern.events(
        { address: { kind: 'session', sessionId }, maxMessages },
        callSignal(),
      )
      return { ok: true, entries: page?.records ?? [] }
    } catch (error) {
      return { ok: false, entries: [], error: messageOf(error) }
    }
  }

  const legacy = legacySessions(ctx)
  if (typeof legacy?.history === 'function') {
    try {
      const response = await legacy.history({
        rpcId: makeRpcId(),
        payload: { sessionId, maxMessages },
      })
      if (!response.result.ok || !response.result.value) {
        return { ok: false, entries: [], error: response.result.error?.message ?? '读取会话历史失败' }
      }
      return { ok: true, entries: response.result.value.events ?? [] }
    } catch (error) {
      return { ok: false, entries: [], error: messageOf(error) }
    }
  }

  return { ok: false, entries: [], error: '读取历史不可用：宿主既没有 sessionController.events，也没有 apiProxy.sessions' }
}

/** 生成一次宿主 RPC 调用 id（旧通道用）。 */
function makeRpcId(): unknown {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
