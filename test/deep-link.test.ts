/**
 * client 深链测试（deep-link.ts）：dingOpen 参数解析与 URL 清理。
 */
import { describe, expect, it } from 'vitest'
import { sessionFromUrl, stripSessionParam } from '../src/client/deep-link.ts'

/** UTF-8 → base64url（与 host 侧 toBase64Url 相同逻辑）。 */
function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

describe('sessionFromUrl', () => {
  it('解析 dingOpen base64url → 会话 id', () => {
    const href = `http://127.0.0.1:3080/?dingOpen=${b64url('sess-abc')}`
    expect(sessionFromUrl(href)).toBe('sess-abc')
  })

  it('支持非 ASCII 会话 id（UTF-8）', () => {
    const href = `http://127.0.0.1:3080/?dingOpen=${b64url('会话123')}`
    expect(sessionFromUrl(href)).toBe('会话123')
  })

  it('无 dingOpen 参数 → undefined', () => {
    expect(sessionFromUrl('http://127.0.0.1:3080/')).toBeUndefined()
    expect(sessionFromUrl('http://127.0.0.1:3080/?x=1')).toBeUndefined()
  })

  it('非法 base64 → undefined（不抛错）', () => {
    expect(sessionFromUrl('http://127.0.0.1:3080/?dingOpen=!!!')).toBeUndefined()
  })
})

describe('stripSessionParam', () => {
  it('去掉 dingOpen 参数，保留其他参数', () => {
    const cleaned = stripSessionParam(`http://127.0.0.1:3080/?dingOpen=${b64url('s')}&x=1`)
    const url = new URL(cleaned)
    expect(url.searchParams.has('dingOpen')).toBe(false)
    expect(url.searchParams.get('x')).toBe('1')
  })

  it('无参数时原样返回', () => {
    expect(stripSessionParam('http://127.0.0.1:3080/')).toBe('http://127.0.0.1:3080/')
  })
})
