/**
 * 测试辅助：fake {@link FeedbackAudio} 与最小反馈配置（feedback 单测共用）。
 */
import type { FeedbackAudio, FeedbackConfig, ToneId } from '../src/feedback.ts'
import type { VoiceState } from '../src/types.ts'

/** 记录调用的 fake 播报音频端口。 */
export class FakeAudio implements FeedbackAudio {
  calls: string[] = []
  spokenTexts: string[] = []
  tones: ToneId[] = []
  _state: VoiceState = 'idle'

  state(): VoiceState {
    return this._state
  }
  pause(): void {
    this.calls.push('pause')
    this._state = 'idle'
  }
  resume(): void {
    this.calls.push('resume')
    this._state = 'idle'
  }
  stop(): void {
    this.calls.push('stop')
    this._state = 'idle'
  }
  speak(text: string): void {
    this.calls.push(`speak:${text}`)
    this.spokenTexts.push(text)
    this._state = 'speaking'
  }
  playTone(tone: ToneId): void {
    this.calls.push(`tone:${tone}`)
    this.tones.push(tone)
  }
}

/** 最小反馈配置（默认：启用、无 DND、去重 10s）。 */
export function feedbackConfig(overrides: Partial<FeedbackConfig> = {}): FeedbackConfig {
  return {
    enabled: true,
    dnd: false,
    confirmNeverSilent: true,
    dedupeWindowMs: 10_000,
    announceOwnSessions: false,
    announceSubagentSessions: false,
    quietHours: { start: '', end: '' },
    toneStyle: 'soft',
    ...overrides,
  }
}

/** 微任务 + 定时器冲刷（等 tick 链走完）。 */
export function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
