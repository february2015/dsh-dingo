/**
 * 统计分桶与排序（SessionCardRailCompact 的纯逻辑）：
 * - 提醒类（异常/疑问/草稿/待阅读/等待）不吃当前对话；
 * - 活动类（执行中/中间输出）照实计入，包括当前对话。
 */
import { describe, expect, it } from 'vitest'
import {
  cardRank,
  clampPillPosition,
  computePanelGeometry,
  draftTextFrom,
  readAllDrafts,
  readStoredPillPosition,
  summaryBucket,
  type SessionCardView,
  type SessionCardStatus,
} from '../src/client/SessionCardRailCompact.tsx'

/** 造一张卡片。 */
function card(sessionId: string, status: SessionCardStatus, extra: Partial<SessionCardView> = {}): SessionCardView {
  return {
    sessionId,
    status,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }
}

const noDraft = (): boolean => false
const noWait = (): boolean => false

describe('summaryBucket：当前对话', () => {
  it('执行中照实计入 running（这就是被吞掉的那个 spinner）', () => {
    expect(summaryBucket(card('cur', 'running'), 'cur', noDraft, noWait)).toBe('running')
  })

  it('执行中且已有中间输出 → intermediate', () => {
    expect(summaryBucket(card('cur', 'running', { hasIntermediate: true }), 'cur', noDraft, noWait)).toBe('intermediate')
  })

  it('异常/疑问/待阅读归中性 normal（不冲当前对话闪红橙绿）', () => {
    expect(summaryBucket(card('cur', 'error'), 'cur', noDraft, noWait)).toBe('normal')
    expect(summaryBucket(card('cur', 'question'), 'cur', noDraft, noWait)).toBe('normal')
    expect(summaryBucket(card('cur', 'answered'), 'cur', noDraft, noWait)).toBe('normal')
  })

  it('当前对话打字不算草稿（自己看着自己不该变紫）', () => {
    const drafting = (id: string): boolean => id === 'cur'
    expect(summaryBucket(card('cur', 'running'), 'cur', drafting, noWait)).toBe('running')
    expect(summaryBucket(card('cur', 'normal'), 'cur', drafting, noWait)).toBe('normal')
  })

  it('当前对话的后台任务不算 waiting', () => {
    const waiting = (id: string): boolean => id === 'cur'
    expect(summaryBucket(card('cur', 'normal'), 'cur', noDraft, waiting)).toBe('normal')
  })
})

describe('summaryBucket：其他对话', () => {
  it('按优先级归桶', () => {
    expect(summaryBucket(card('b', 'error'), 'cur', noDraft, noWait)).toBe('error')
    expect(summaryBucket(card('b', 'question'), 'cur', noDraft, noWait)).toBe('question')
    expect(summaryBucket(card('b', 'answered'), 'cur', noDraft, noWait)).toBe('answered')
    expect(summaryBucket(card('b', 'running'), 'cur', noDraft, noWait)).toBe('running')
    expect(summaryBucket(card('b', 'running', { hasIntermediate: true }), 'cur', noDraft, noWait)).toBe('intermediate')
    expect(summaryBucket(card('b', 'normal'), 'cur', noDraft, noWait)).toBe('normal')
  })

  it('待阅读高于草稿，草稿高于执行中/等待；等待只对 normal 生效', () => {
    const drafting = (id: string): boolean => id === 'b'
    // 已经有结论要你看时，草稿不该把它顶掉
    expect(summaryBucket(card('b', 'answered'), 'cur', drafting, noWait)).toBe('answered')
    // 草稿仍强于"正在跑"和"已读"
    expect(summaryBucket(card('b', 'running'), 'cur', drafting, noWait)).toBe('draft')
    expect(summaryBucket(card('b', 'normal'), 'cur', drafting, noWait)).toBe('draft')
    const waiting = (id: string): boolean => id === 'b'
    expect(summaryBucket(card('b', 'normal'), 'cur', noDraft, waiting)).toBe('waiting')
    // 执行中不会被「等待后台」抢走（它本来就在跑）
    expect(summaryBucket(card('b', 'running'), 'cur', noDraft, waiting)).toBe('running')
  })
})

describe('cardRank', () => {
  it('当前对话不因草稿/等待被顶到最前', () => {
    const drafting = (id: string): boolean => id === 'cur'
    expect(cardRank(card('cur', 'answered'), drafting, noWait, 'cur')).toBe(2)
    expect(cardRank(card('cur', 'normal'), drafting, noWait, 'cur')).toBe(7)
    expect(cardRank(card('cur', 'normal'), noDraft, (id) => id === 'cur', 'cur')).toBe(7)
  })

  it('其他对话：待阅读(2) > 草稿(3) > 等待(4)', () => {
    const drafting = (id: string): boolean => id === 'b'
    expect(cardRank(card('b', 'answered'), drafting, noWait, 'cur')).toBe(2)
    expect(cardRank(card('b', 'normal'), drafting, noWait, 'cur')).toBe(3)
    expect(cardRank(card('b', 'normal'), noDraft, (id) => id === 'b', 'cur')).toBe(4)
  })
})

describe('草稿存储解析', () => {
  it('兼容三种落盘形状', () => {
    expect(draftTextFrom('纯字符串草稿')).toBe('纯字符串草稿')
    expect(draftTextFrom({ draft: { text: '现版草稿', references: [] } })).toBe('现版草稿')
    expect(draftTextFrom({ draft: '旧版草稿' })).toBe('旧版草稿')
    expect(draftTextFrom({ draft: { text: '', references: [] } })).toBe('')
    expect(draftTextFrom(null)).toBe('')
    expect(draftTextFrom(42)).toBe('')
    expect(draftTextFrom({})).toBe('')
  })

  it('无 localStorage 时返回空表而不是抛错', () => {
    expect(readAllDrafts()).toEqual({})
  })
})

describe('手机浮层胶囊位置', () => {
  const viewport = { width: 390, height: 844 }
  const size = { width: 60, height: 24 }

  it('视口内原样返回', () => {
    expect(clampPillPosition({ x: 200, y: 300 }, viewport, size)).toEqual({ x: 200, y: 300 })
  })

  it('越界夹回视口（四边留 margin）', () => {
    expect(clampPillPosition({ x: 9999, y: 9999 }, viewport, size)).toEqual({ x: 390 - 60 - 4, y: 844 - 24 - 4 })
    expect(clampPillPosition({ x: -50, y: -50 }, viewport, size)).toEqual({ x: 4, y: 4 })
  })

  it('胶囊比视口还大时退化为 margin 处（不产生负坐标）', () => {
    expect(clampPillPosition({ x: 100, y: 100 }, { width: 40, height: 10 }, size)).toEqual({ x: 4, y: 4 })
  })

  it('无 localStorage 时没有历史位置（用默认右上角）', () => {
    expect(readStoredPillPosition()).toBeUndefined()
  })
})

describe('浮层面板几何', () => {
  const viewport = { width: 390, height: 844 }

  it('药丸在右侧：面板向左伸且右缘不出界', () => {
    const geom = computePanelGeometry({ pillLeft: 280, pillTop: 52, pillHeight: 24, viewport })
    expect(geom.width).toBeLessThanOrEqual(320)
    // 面板右缘 = 药丸左边 + 偏移 + 宽 ≤ 屏宽 - 边距
    expect(280 + geom.left + geom.width).toBeLessThanOrEqual(390 - 8 + 0.01)
    expect(geom.openUpward).toBe(false)
  })

  it('药丸拖到中间也不会两边出界', () => {
    const geom = computePanelGeometry({ pillLeft: 150, pillTop: 400, pillHeight: 24, viewport })
    expect(150 + geom.left).toBeGreaterThanOrEqual(8 - 0.01)
    expect(150 + geom.left + geom.width).toBeLessThanOrEqual(390 - 8 + 0.01)
  })

  it('药丸在左上角：面板贴左边距，不出左界', () => {
    const geom = computePanelGeometry({ pillLeft: 4, pillTop: 40, pillHeight: 24, viewport })
    expect(4 + geom.left).toBeCloseTo(8, 5)
  })

  it('药丸在下半屏：向上弹，且高度不超过上方可用空间', () => {
    const geom = computePanelGeometry({ pillLeft: 300, pillTop: 700, pillHeight: 24, viewport })
    expect(geom.openUpward).toBe(true)
    expect(geom.maxHeight).toBeLessThanOrEqual(Math.max(120, 700 - 8))
    expect(geom.maxHeight).toBeGreaterThanOrEqual(120)
  })

  it('小屏（宽 320）时宽度跟着收缩，仍不出界', () => {
    const geom = computePanelGeometry({ pillLeft: 200, pillTop: 100, pillHeight: 24, viewport: { width: 320, height: 568 } })
    expect(geom.width).toBeLessThanOrEqual(320)
    expect(geom.width).toBeGreaterThanOrEqual(240)
    expect(200 + geom.left + geom.width).toBeLessThanOrEqual(320 - 8 + 0.01)
  })
})
