/**
 * 提醒引擎测试（feedback.ts，复用自 dsh-localvoice）：
 * - 其他对话回复：含疑问 → need-confirm（叮叮 2 声），否则 task-done（叮 1 声）；
 * - 当前对话回复 → own 提醒（只播提示音、不显示卡片）；
 * - need-confirm（approval/ask_user/questions）当前对话也提醒；
 * - DND / 去重 / 静音时段。
 */
import { describe, expect, it } from 'vitest'
import { FeedbackEngine, formatAnnouncement, firstParagraph, isQuietNow, toMinutes } from '../src/feedback.ts'
import { FakeAudio, feedbackConfig, flush } from './feedback-fixture.ts'
import type { FeedbackAudio } from '../src/feedback.ts'

function build(options: {
  audio?: FeedbackAudio
  config?: Partial<ReturnType<typeof feedbackConfig>>
  autoComplete?: boolean
  resolveWorkspace?: (sessionId: string, cwd?: string) => Promise<string | undefined>
  resolveSessionTitle?: (sessionId: string) => Promise<string | undefined>
  now?: () => number
} = {}) {
  const audio = options.audio ?? new FakeAudio()
  const engine = new FeedbackEngine({
    audio,
    config: feedbackConfig(options.config),
    resolveWorkspace: options.resolveWorkspace ?? (async () => undefined),
    resolveSessionTitle: options.resolveSessionTitle ?? (async () => undefined),
    autoCompleteSpeech: options.autoComplete ?? true,
    now: options.now,
  })
  return { engine, audio }
}

function sessionEvent(type: string, data: unknown = {}, extra: Record<string, unknown> = {}): { type: string; data: unknown; [k: string]: unknown } {
  return { type, data, ...extra }
}

describe('事件源分类（Step 1）', () => {
  it('其他对话回复含疑问（assistant/message + turn/end）→ need-confirm（叮叮）', async () => {
    const { engine, audio } = build({
      resolveWorkspace: async (id) => (id === 'sess-b' ? '电网工作区' : undefined),
    })
    engine.handleSessionEvent({ id: 'sess-b' }, sessionEvent('assistant/message', undefined, { message: { content: [{ type: 'text', text: '要部署到生产环境吗？' }] } }))
    engine.handleSessionEvent({ id: 'sess-b' }, sessionEvent('turn/end', { reason: { kind: 'completed' } }))
    await flush()
    expect(audio.tones).toEqual(['ding-ding'])
    const spoken = audio.spokenTexts[0]
    expect(spoken).toContain('需回答')
    expect(spoken).toContain('电网工作区')
  })

  it('其他对话回复为普通陈述 → task-done（叮 1 声）', async () => {
    const { engine, audio } = build()
    engine.handleSessionEvent({ id: 'sess-b' }, sessionEvent('assistant/message', undefined, { message: { content: '构建通过，测试全绿' } }))
    engine.handleSessionEvent({ id: 'sess-b' }, sessionEvent('turn/end', { reason: { kind: 'completed' } }))
    await flush()
    expect(audio.tones).toEqual(['ding'])
    expect(audio.spokenTexts[0]).toContain('有回复')
  })

  it('approval/asked → need-confirm（叮叮，当前对话也提醒）', async () => {
    const { engine, audio } = build()
    engine.setActiveSession('sess-a')
    engine.handleSessionEvent({ id: 'sess-a' }, sessionEvent('approval/asked', { toolName: 'bash', reason: '执行部署' }))
    await flush()
    expect(audio.tones).toEqual(['ding-ding'])
    expect(audio.spokenTexts[0]).toContain('需回答')
  })

  it('ask_user 工具调用 → need-confirm（需回答）', async () => {
    const { engine, audio } = build({ resolveWorkspace: async () => '电网工作区' })
    engine.handleSessionEvent({ id: 'sess-b' }, sessionEvent('tool/call', { name: 'ask_user', arguments: '{}' }))
    await flush()
    expect(audio.spokenTexts[0]).toContain('需回答')
    expect(audio.spokenTexts[0]).toContain('电网工作区')
  })

  it('turn/end aborted → 不提醒', async () => {
    const { engine, audio } = build()
    engine.handleSessionEvent({ id: 'sess-b' }, sessionEvent('turn/end', { reason: { kind: 'aborted' } }))
    await flush()
    expect(audio.spokenTexts).toHaveLength(0)
  })
})

describe('own 标记（当前对话）', () => {
  it('当前对话的 need-confirm → own=true（client 只播提示音不显示卡片）', async () => {
    // autoComplete=false：项停留在队列（speaking），快照可见 own 标记
    const { engine } = build({ autoComplete: false })
    engine.setActiveSession('sess-a')
    engine.handleSessionEvent({ id: 'sess-a' }, sessionEvent('approval/asked', { toolName: 'bash' }))
    await flush()
    const view = engine.pendingViews().find((item) => item.category === 'need-confirm')
    expect(view?.own).toBe(true)
    // 非当前对话 → own 缺失
    engine.handleSessionEvent({ id: 'sess-b' }, sessionEvent('turn/end', { reason: { kind: 'completed' } }))
    await flush()
    const other = engine.pendingViews().find((item) => item.sessionId === 'sess-b')
    expect(other?.own).not.toBe(true)
  })
})

describe('模板（Step 2）', () => {
  it('提醒文案：只带工作区 + 类型，不带摘要/会话名', () => {
    expect(formatAnnouncement('task-done', { workspaceTitle: '电网工作区', sessionTitle: '部署检查', summary: '构建通过' }))
      .toBe('【叮】电网工作区有回复')
    expect(formatAnnouncement('task-done', { workspaceTitle: '', sessionTitle: '部署检查', summary: '构建通过' }))
      .toBe('【叮】有回复')
    expect(formatAnnouncement('need-confirm', { workspaceTitle: '电网工作区', summary: 'x' }))
      .toBe('【叮叮】电网工作区需回答')
    expect(formatAnnouncement('need-confirm', { summary: 'x' }))
      .toBe('【叮叮】需回答')
    expect(formatAnnouncement('task-error', { name: '数据迁移', summary: '磁盘空间不足' }))
      .toBe('【咚】任务失败')
  })
})

describe('DND 与去重', () => {
  it('DND：任务完成类静音（deferred），需回答仍播', async () => {
    const { engine, audio } = build({ config: { dnd: true } })
    engine.handleSessionEvent({ id: 'sess-b' }, sessionEvent('turn/end', { reason: { kind: 'completed' } }))
    await flush()
    expect(audio.spokenTexts).toHaveLength(0)
    engine.handleSessionEvent({ id: 'sess-b' }, sessionEvent('approval/asked', { toolName: 'bash' }))
    await flush()
    expect(audio.spokenTexts[0]).toContain('需回答')
  })

  it('同会话同类型 30s 去重', async () => {
    const { engine, audio } = build()
    engine.handleSessionEvent({ id: 'sess-b' }, sessionEvent('turn/end', { reason: { kind: 'completed' } }))
    await flush()
    engine.handleSessionEvent({ id: 'sess-b' }, sessionEvent('turn/end', { reason: { kind: 'completed' } }))
    await flush()
    expect(audio.spokenTexts).toHaveLength(1)
  })
})

describe('工具函数', () => {
  it('isQuietNow / toMinutes', () => {
    expect(toMinutes('22:30')).toBe(22 * 60 + 30)
    expect(toMinutes('bad')).toBe(-1)
    expect(isQuietNow({ start: '22:00', end: '06:00' }, new Date('2026-08-15T23:30:00'))).toBe(true)
    expect(isQuietNow({ start: '', end: '' }, new Date())).toBe(false)
  })

  it('firstParagraph', () => {
    expect(firstParagraph('# 标题\n第一段 有 内容')).toBe('第一段 有 内容')
  })
})
