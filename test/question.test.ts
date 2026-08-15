/**
 * 回复文本判定（dsh-dingo 核心：叮=有回复 / 叮叮=需回答）。
 */
import { describe, expect, it } from 'vitest'
import { isQuestionText } from '../src/question.ts'

describe('isQuestionText', () => {
  it('问号结尾 → 需回答', () => {
    expect(isQuestionText('部署到生产环境吗？')).toBe(true)
    expect(isQuestionText('明天几点开会?')).toBe(true)
  })

  it('疑问词 → 需回答', () => {
    expect(isQuestionText('你觉得这样可以吗')).toBe(true)
    expect(isQuestionText('请确认一下这个版本号')).toBe(true)
    expect(isQuestionText('我们怎么做这个方案')).toBe(true)
    expect(isQuestionText('是否需要继续')).toBe(true)
  })

  it('普通陈述 → 有回复', () => {
    expect(isQuestionText('构建通过，测试全绿')).toBe(false)
    expect(isQuestionText('部署已完成')).toBe(false)
  })

  it('空文本 → 有回复（不判定）', () => {
    expect(isQuestionText('')).toBe(false)
    expect(isQuestionText('   ')).toBe(false)
  })
})
