/**
 * 统计分桶与排序（SessionCardRailCompact 的纯逻辑）：
 * - 提醒类（异常/疑问/草稿/待阅读/等待）不吃当前对话；
 * - 活动类（执行中/中间输出）照实计入，包括当前对话。
 */
import { describe, expect, it } from 'vitest'
import { cardRank, summaryBucket, type SessionCardView, type SessionCardStatus } from '../src/client/SessionCardRailCompact.tsx'

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

  it('草稿优先于待阅读/执行中，等待只对 normal 生效', () => {
    const drafting = (id: string): boolean => id === 'b'
    expect(summaryBucket(card('b', 'answered'), 'cur', drafting, noWait)).toBe('draft')
    expect(summaryBucket(card('b', 'running'), 'cur', drafting, noWait)).toBe('draft')
    const waiting = (id: string): boolean => id === 'b'
    expect(summaryBucket(card('b', 'normal'), 'cur', noDraft, waiting)).toBe('waiting')
    // 执行中不会被「等待后台」抢走（它本来就在跑）
    expect(summaryBucket(card('b', 'running'), 'cur', noDraft, waiting)).toBe('running')
  })
})

describe('cardRank', () => {
  it('当前对话不因草稿/等待被顶到最前', () => {
    const drafting = (id: string): boolean => id === 'cur'
    expect(cardRank(card('cur', 'answered'), drafting, noWait, 'cur')).toBe(3)
    expect(cardRank(card('cur', 'normal'), noDraft, (id) => id === 'cur', 'cur')).toBe(7)
    // 同一张卡不是当前对话时，草稿确实会提前
    expect(cardRank(card('cur', 'answered'), drafting, noWait, 'other')).toBe(2)
  })
})
