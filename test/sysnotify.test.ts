/**
 * 系统通知模块测试（sysnotify.ts）：深链 URL 生成（dingOpen base64url 格式）。
 */
import { describe, expect, it } from 'vitest'
import { deepLinkUrl, toBase64Url } from '../src/sysnotify.ts'

describe('toBase64Url', () => {
  it('UTF-8 → base64url（URL 安全字符集，无填充）', () => {
    expect(toBase64Url('sess-abc')).toBe('c2Vzcy1hYmM')
    expect(toBase64Url('你好')).toBe('5L2g5aW9')
  })

  it('往返一致', () => {
    for (const s of ['sess-abc', 'sess_123', '你好，世界', 'a/b+c=d']) {
      const enc = toBase64Url(s)
      const dec = Buffer.from(enc, 'base64url').toString('utf8')
      expect(dec).toBe(s)
    }
  })
})

describe('deepLinkUrl', () => {
  it('生成 ?dingOpen= 深链（dsh-ding 同款格式，点击直达会话）', () => {
    const url = deepLinkUrl('http://127.0.0.1:3080', 'sess-abc')
    expect(url).toContain('dingOpen=c2Vzcy1hYmM')
    expect(new URL(url).searchParams.get('dingOpen')).toBe('c2Vzcy1hYmM')
  })

  it('保留 baseUrl 已有路径/参数', () => {
    const url = deepLinkUrl('http://127.0.0.1:3080/web?x=1', 'sess-1')
    const parsed = new URL(url)
    expect(parsed.pathname).toBe('/web')
    expect(parsed.searchParams.get('x')).toBe('1')
    expect(parsed.searchParams.get('dingOpen')).toBeDefined()
  })
})
