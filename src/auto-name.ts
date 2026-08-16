/**
 * dsh-dingo 2.0 — 对话自动命名（host 侧）。
 *
 * 双入口（header 按钮 / agent 自然语言指令）最终都调用这里的 `autoNameSession`：
 * 读取近期用户消息（合并后喂给 LLM）→ 优先用 DeepSeek V4 Flash 生成有区分度的标题，
 * 失败时规则回退 → `session.rename`。
 *
 * @module dsh-dingo/auto-name
 */
import type { Context } from '@deepseek-ai/cordis'

/** 自动命名结果。 */
export interface AutoNameResult {
  ok: boolean
  title?: string
  error?: string
}

/** 会话历史/重命名 API 的最小形状（避免强耦合）。 */
interface SessionsApiLike {
  history(request: { rpcId: unknown; payload: { sessionId: string; maxMessages?: number } }): Promise<{
    result: {
      ok: boolean
      value?: { events?: readonly HistoryEntryLike[] }
      error?: { message?: string }
    }
  }>
  rename(request: { rpcId: unknown; payload: { sessionId: string; title: string } }): Promise<{
    result: {
      ok: boolean
      value?: { title: string }
      error?: { message?: string }
    }
  }>
}

interface HistoryEntryLike {
  event?: { type?: string; data?: Record<string, unknown>; [key: string]: unknown }
}

/**
 * 执行自动命名：读取最近消息 → 规则生成标题 → 写入 session.rename。
 * 返回新标题；失败时保持原名并返回错误信息。
 */
export async function autoNameSession(ctx: Context, sessionId: string): Promise<AutoNameResult> {
  const api = (ctx as unknown as { apiProxy?: { sessions?: SessionsApiLike } }).apiProxy
  if (!api?.sessions) {
    return { ok: false, error: '自动命名不可用：缺少 apiProxy.sessions' }
  }

  const rpcId = makeRpcId()
  const history = await api.sessions.history({ rpcId, payload: { sessionId, maxMessages: 20 } })
  if (!history.result.ok || !history.result.value) {
    return { ok: false, error: history.result.error?.message ?? '读取会话历史失败' }
  }

  const texts = extractRecentUserTexts(history.result.value.events ?? [])
  const title = (await generateTitleWithLlm(ctx, texts)) ?? generateTitle(texts)
  if (!title) {
    return { ok: false, error: '未能从对话内容生成有效标题' }
  }

  const renamed = await api.sessions.rename({ rpcId, payload: { sessionId, title } })
  if (!renamed.result.ok) {
    return { ok: false, error: renamed.result.error?.message ?? '写入标题失败' }
  }

  return { ok: true, title: renamed.result.value?.title ?? title }
}

/** 从 history 事件中提取最近 user 纯文本（只取用户输入，省 token 且更代表意图）。 */
function extractRecentUserTexts(events: readonly HistoryEntryLike[]): string[] {
  const texts: string[] = []
  for (const entry of events) {
    const event = entry.event
    if (!event) continue
    if (event.type !== 'user/message') continue
    const data = event.data as { message?: { content?: unknown } } | undefined
    const message = data?.message ?? (event.message as { content?: unknown } | undefined)
    const text = extractText(message?.content)
    if (text) texts.push(text)
  }
  // 最近消息在尾部；只取最近 5 条用户消息，控制 token 成本。
  return texts.slice(-5)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractText(content: any): string {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text
        return ''
      })
      .filter(Boolean)
      .join(' ')
      .trim()
  }
  return ''
}

/**
 * 用 DeepSeek V4 Flash 生成标题。
 * 依赖宿主已装配 `ctx.llm`；不可用或生成失败时返回 undefined，由规则回退接管。
 */
async function generateTitleWithLlm(ctx: Context, texts: string[]): Promise<string | undefined> {
  const llm = ctx.get('llm') as { stream(options: unknown): AsyncIterable<{ type: string; text?: string }> } | undefined
  if (!llm?.stream || texts.length === 0) return undefined

  const prompt = [
    '请根据以下最近 5 条用户消息，生成一个简洁、准确且有区分度的会话标题。',
    '要求：',
    '- 中文 6~20 字，或英文 3~12 词；',
    '- 标题要具体，尤其开头几个字要能和其他会话明显区分，避免都是“帮我/优化/请问”这类雷同前缀；',
    '- 只输出标题本身，不要解释、不要思考过程、不要引号。',
    '',
    '最近用户消息：',
    ...texts.slice(-5).map((text, index) => `${index + 1}. ${text}`),
  ].join('\n')

  try {
    let title = ''
    const stream = llm.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      purpose: 'session-title',
      temperature: 0.3,
      maxTokens: 60,
      messages: [
        { role: 'user', content: [{ type: 'text', text: prompt }] },
      ],
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        title += chunk.text
      }
    }
    const clean = title.replace(/^["'“”]+|["'“”]+$/g, '').trim()
    return clean || undefined
  } catch {
    return undefined
  }
}

/** 规则回退标题：取第一条用户消息，截断到 20 字。 */
function generateTitle(texts: string[]): string | undefined {
  const clean = (value: string): string =>
    value
      .replace(/[#*_>`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim()

  const userText = texts.find((text) => text.length > 0)
  if (!userText) return undefined
  const candidate = clean(userText)
  if (!candidate) return undefined
  return candidate.length <= 20 ? candidate : `${candidate.slice(0, 20)}…`
}

/** 生成一次宿主 RPC 调用 id。 */
function makeRpcId(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
