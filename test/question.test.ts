/**
 * 回复文本判定（dsh-dingo 核心：叮=有回复 / 叮叮=需回答）。
 * 2026-08-15 收紧：排除 AI 思考过程中的反问、自问自答、问题清单列举；
 * 疑问词出现在陈述句里（无问号）不再判"需回答"。
 */
import { describe, expect, it } from 'vitest'
import { isQuestionText } from '../src/question.ts'

describe('isQuestionText', () => {
  it('问号 + 疑问语气 → 需回答', () => {
    expect(isQuestionText('部署到生产环境吗？')).toBe(true)
    expect(isQuestionText('明天几点开会?')).toBe(true)
    expect(isQuestionText('这样可以吗？')).toBe(true)
    expect(isQuestionText('需要我调整一下吗？')).toBe(true)
    expect(isQuestionText('为什么选择这个方案？')).toBe(true)
  })

  it('明确请求动作/决策/确认（无需问号）→ 需回答', () => {
    expect(isQuestionText('请确认一下这个版本号')).toBe(true)
    expect(isQuestionText('请选择部署方式')).toBe(true)
    expect(isQuestionText('需要你拍板')).toBe(true)
    expect(isQuestionText('你怎么看这个方案')).toBe(true)
    expect(isQuestionText('你觉得呢')).toBe(true)
  })

  it('反问/修辞句 → 有回复（AI 自问自答，不需要用户回答）', () => {
    expect(isQuestionText('难道这不明显吗？')).toBe(false)
    expect(isQuestionText('这不是明摆着的吗？')).toBe(false)
    expect(isQuestionText('何必纠结这些细节呢？')).toBe(false)
    expect(isQuestionText('怎么会出这种问题呢？')).toBe(false)
  })

  it('自问自答（问号后紧跟答案）→ 有回复', () => {
    expect(isQuestionText('是否需要回滚？不需要，因为测试全过。')).toBe(false)
    expect(isQuestionText('这样可行吗？其实还有更简单的做法。')).toBe(false)
    expect(isQuestionText('为什么要这么做？因为性能更好。')).toBe(false)
    expect(isQuestionText('该不该上线？答案是肯定的。')).toBe(false)
  })

  it('问题清单列举 → 有回复（AI 在列待办，非请求回答）', () => {
    expect(isQuestionText('还需要考虑性能如何？其次还有兼容性。')).toBe(false)
    expect(isQuestionText('两个点：方案怎么选？1. 成本。')).toBe(false)
  })

  it('疑问词只出现在陈述句里（无问号）→ 有回复', () => {
    expect(isQuestionText('我在想是否需要优化一下性能。')).toBe(false)
    expect(isQuestionText('我们怎么做这个方案')).toBe(false)
    expect(isQuestionText('你觉得这样可以吗')).toBe(false)
    expect(isQuestionText('需要考虑兼容性和稳定性如何')).toBe(false)
  })

  it('普通陈述 → 有回复', () => {
    expect(isQuestionText('构建通过，测试全绿')).toBe(false)
    expect(isQuestionText('部署已完成')).toBe(false)
  })

  it('英文真问句 → 需回答', () => {
    expect(isQuestionText('Can we deploy to production?')).toBe(true)
    expect(isQuestionText('What do you think about this plan?')).toBe(true)
    expect(isQuestionText('Is the build green now?')).toBe(true)
    expect(isQuestionText('Why did the test fail?')).toBe(true)
    expect(isQuestionText('Please confirm the version number.')).toBe(true) // 请求短语，无需问号
    expect(isQuestionText('The build passed?')).toBe(true) // 短句确认
  })

  it('英文反问/自问自答/修辞 → 有回复', () => {
    expect(isQuestionText("Isn't this obvious?")).toBe(false)
    expect(isQuestionText('Why not just deploy it directly?')).toBe(false)
    expect(isQuestionText('Should we roll back? No, because tests passed.')).toBe(false)
    expect(isQuestionText('Is this the right approach? Actually there is a simpler way.')).toBe(false)
    expect(isQuestionText('The build passed, didn\'t it?')).toBe(false) // 反意疑问
  })

  it('空文本 → 有回复（不判定）', () => {
    expect(isQuestionText('')).toBe(false)
    expect(isQuestionText('   ')).toBe(false)
  })
})
