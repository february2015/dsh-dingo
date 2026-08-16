import { describe, expect, it } from 'vitest'
import { autoNameSession } from '../src/auto-name.ts'

function fakeCtx(overrides: {
  history?: () => unknown
  rename?: () => unknown
  noSessions?: boolean
} = {}) {
  return {
    get: () => undefined,
    apiProxy: overrides.noSessions ? undefined : {
      sessions: {
        history: overrides.history ?? (async () => ({
          result: {
            ok: true,
            value: {
              events: [
                { event: { type: 'user/message', data: { content: '帮我优化一下这个项目的构建流程' } } },
                { event: { type: 'assistant/message', data: { message: { content: '好的，我来分析构建脚本。' } } } },
              ],
            },
          },
        })),
        rename: overrides.rename ?? (async (request: { payload: { title: string } }) => ({
          result: { ok: true, value: { title: request.payload.title, seq: 1 } },
        })),
      },
    },
  }
}

describe('autoNameSession', () => {
  it('从最近 user 消息生成标题并调用 rename', async () => {
    let renamed = ''
    const ctx = fakeCtx({
      rename: async (request: { payload: { title: string } }) => {
        renamed = request.payload.title
        return { result: { ok: true, value: { title: request.payload.title, seq: 1 } } }
      },
    }) as never
    const result = await autoNameSession(ctx as never, 'sess-1')
    expect(result.ok).toBe(true)
    expect(result.title).toBe('帮我优化一下这个项目的构建流程')
    expect(renamed).toBe('帮我优化一下这个项目的构建流程')
  })

  it('缺少 apiProxy.sessions 时返回失败', async () => {
    const ctx = fakeCtx({ noSessions: true }) as never
    const result = await autoNameSession(ctx as never, 'sess-1')
    expect(result.ok).toBe(false)
  })

  it('rename 失败时返回失败且保持原名', async () => {
    const ctx = fakeCtx({
      rename: async () => ({ result: { ok: false, error: { message: 'title-invalid' } } }),
    }) as never
    const result = await autoNameSession(ctx as never, 'sess-1')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('title-invalid')
  })
})
