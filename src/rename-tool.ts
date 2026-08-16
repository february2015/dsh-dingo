/**
 * dsh-dingo 2.0 — 对话内自然语言重命名工具（host 侧）。
 *
 * 这个工具让主 LLM 在当前对话上下文中直接生成标题（吃到缓存），
 * 然后调用本工具把标题写入 `session.rename`。
 * 按钮入口仍走独立的 `/dingo.auto-name`（DeepSeek V4 Flash）。
 *
 * @module dsh-dingo/rename-tool
 */
import type { Context } from '@deepseek-ai/cordis'

/** 注册 `rename_current_session` 工具；无 tools 服务时静默跳过。 */
export function installRenameTool(ctx: Context): void {
  const tools = (ctx as unknown as { tools?: { register(definition: unknown): () => void } }).tools
  if (!tools?.register) return

  const tool = {
    name: 'rename_current_session',
    description: '根据当前对话内容生成一个简洁、准确且有区分度的新标题，并重命名当前会话。'
      + '要求：只输出标题本身；中文 6~20 字，或英文 3~12 词；'
      + '标题要具体，尤其开头几个字要能和其他会话明显区分，避免都是“帮我/优化/请问”这类雷同前缀。'
      + '请结合当前对话最近几条用户消息来生成，不要解释、不要思考过程。',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '新会话标题，只包含标题本身',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          title: { type: 'string' },
        },
        required: ['ok', 'title'],
        additionalProperties: false,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_args: any, value: any) => [{ type: 'text', text: `已重命名为：${value.title}` }],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async execute(args: any, exec: any): Promise<{ ok: boolean; title: string }> {
      const sessionId = String(exec?.agent?.session?.id ?? exec?.agent?.id ?? '')
      if (!sessionId) throw new Error('无法确定当前会话')
      const api = (ctx as unknown as { apiProxy?: { sessions?: { rename(request: { sessionId: string; title: string }): Promise<{ result: { ok: boolean; value?: { title: string }; error?: { message?: string } } }> } } }).apiProxy
      if (!api?.sessions?.rename) throw new Error('重命名服务不可用')
      const result = await api.sessions.rename({ sessionId, title: String(args.title) })
      if (!result.result.ok) throw new Error(result.result.error?.message ?? '重命名失败')
      return { ok: true, title: result.result.value?.title ?? String(args.title) }
    },
  }

  ctx.effect(() => tools.register(tool), 'dsh-dingo: rename tool')
}
