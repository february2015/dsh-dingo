/**
 * 宿主会话清单转换（`toSessionSummaries`）：给客户端补卡/补标题用。
 */
import { describe, expect, it } from 'vitest'
import { SESSION_LIST_CAP, toSessionSummaries } from '../src/index.ts'

describe('toSessionSummaries', () => {
  it('标题优先取 title 投影，其次投影缓存兜底', () => {
    const result = toSessionSummaries(
      [
        { sessionId: 's1', projections: { values: { title: '投影标题' } }, running: true, updatedAt: 10 },
        { sessionId: 's2', running: false, updatedAt: 20, cwd: '/tmp/proj' },
      ],
      (id) => (id === 's2' ? '缓存标题' : undefined),
    )
    expect(result).toEqual([
      { sessionId: 's1', title: '投影标题', cwd: undefined, running: true, updatedAt: 10, origin: undefined, parentSessionId: undefined },
      { sessionId: 's2', title: '缓存标题', cwd: '/tmp/proj', running: false, updatedAt: 20, origin: undefined, parentSessionId: undefined },
    ])
  })

  it('空标题/非法条目被跳过，running 归一化为布尔', () => {
    const result = toSessionSummaries([
      { sessionId: '', running: true },
      { sessionId: 'ok', projections: { values: { title: '' } } },
    ] as never)
    expect(result).toHaveLength(1)
    expect(result[0]?.sessionId).toBe('ok')
    expect(result[0]?.title).toBeUndefined()
    expect(result[0]?.running).toBe(false)
  })

  it('保留 subagent 标记与父会话（客户端据此过滤）', () => {
    const result = toSessionSummaries([
      { sessionId: 'child', origin: 'subagent', parentSessionId: 'parent', running: true },
    ])
    expect(result[0]?.origin).toBe('subagent')
    expect(result[0]?.parentSessionId).toBe('parent')
  })

  it('条目数按上限截断', () => {
    const many = Array.from({ length: SESSION_LIST_CAP + 50 }, (_, index) => ({ sessionId: `s${index}` }))
    expect(toSessionSummaries(many)).toHaveLength(SESSION_LIST_CAP)
  })
})
