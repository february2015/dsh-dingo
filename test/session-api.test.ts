/**
 * 会话 API 适配层测试（session-api.ts）：
 * - 0.2 的 `sessionController` 优先；
 * - 旧 `apiProxy.sessions` 兜底；
 * - 两者都没有 → 明确报错（不再是"按钮点了没反应"）。
 */
import { describe, expect, it } from 'vitest'
import { readRecentHistory, renameSessionTitle } from '../src/session-api.ts'

/** 只提供 sessionController 的宿主。 */
function modernCtx(controller: unknown): never {
  return { get: (name: string) => (name === 'sessionController' ? controller : undefined) } as never
}

/** 只提供 apiProxy.sessions 的旧宿主。 */
function legacyCtx(sessions: unknown): never {
  return { get: () => undefined, apiProxy: { sessions } } as never
}

/** 什么都没有的宿主。 */
function bareCtx(): never {
  return { get: () => undefined } as never
}

describe('renameSessionTitle', () => {
  it('优先走 sessionController.rename', async () => {
    const ctx = modernCtx({ rename: async (req: { title: string }) => ({ title: req.title, seq: 3 }) })
    await expect(renameSessionTitle(ctx, 's1', '新标题')).resolves.toEqual({ ok: true, title: '新标题' })
  })

  it('sessionController.rename 抛错 → 失败并带原因', async () => {
    const ctx = modernCtx({ rename: async () => { throw new Error('session/conflict') } })
    const result = await renameSessionTitle(ctx, 's1', 'x')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('session/conflict')
  })

  it('旧宿主回退 apiProxy.sessions.rename', async () => {
    const ctx = legacyCtx({
      rename: async (req: { payload: { title: string } }) => ({ result: { ok: true, value: { title: req.payload.title } } }),
    })
    await expect(renameSessionTitle(ctx, 's1', '旧标题')).resolves.toEqual({ ok: true, title: '旧标题' })
  })

  it('旧宿主 rename 业务失败 → 透传错误', async () => {
    const ctx = legacyCtx({ rename: async () => ({ result: { ok: false, error: { message: 'title-invalid' } } }) })
    const result = await renameSessionTitle(ctx, 's1', 'x')
    expect(result).toEqual({ ok: false, error: 'title-invalid' })
  })

  it('两种服务都没有 → 明确报错', async () => {
    const result = await renameSessionTitle(bareCtx(), 's1', 'x')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('sessionController.rename')
  })
})

describe('readRecentHistory', () => {
  it('优先走 sessionController.events（records 即历史条目）', async () => {
    const ctx = modernCtx({
      events: async () => ({ records: [{ type: 'event', event: { type: 'user/message', data: { content: '你好' } } }] }),
    })
    const result = await readRecentHistory(ctx, 's1', 10)
    expect(result.ok).toBe(true)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.event?.type).toBe('user/message')
  })

  it('旧宿主回退 apiProxy.sessions.history', async () => {
    const ctx = legacyCtx({
      history: async () => ({ result: { ok: true, value: { events: [{ event: { type: 'user/message' } }] } } }),
    })
    const result = await readRecentHistory(ctx, 's1')
    expect(result.ok).toBe(true)
    expect(result.entries).toHaveLength(1)
  })

  it('旧宿主 history 失败 → 返回错误文案', async () => {
    const ctx = legacyCtx({ history: async () => ({ result: { ok: false, error: { message: 'missing' } } }) })
    const result = await readRecentHistory(ctx, 's1')
    expect(result).toEqual({ ok: false, entries: [], error: 'missing' })
  })

  it('两种服务都没有 → 返回错误文案', async () => {
    const result = await readRecentHistory(bareCtx(), 's1')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('sessionController.events')
  })
})
