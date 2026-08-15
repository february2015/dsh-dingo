/**
 * dsh-dingo — client half：右上角提醒卡片 + 提示音播放。
 *
 * 卡片注册进 `shell.overlay`（全局浮层）：
 * - 轮询 `/dingo.feedback {action:'announcements'}` 取提醒队列快照；
 * - 当前对话（own）项 → 只播提示音（crisp 档"当"：叮=有回复 / 叮叮=需回答），不显示卡片；
 * - 其他对话项 → 另一套声音（soft 档"叮"）1 声/2 声 + 右上角小卡片
 *   （工作区 + 对话标题 + 状态图标），点击直达对话、× 关闭；
 * - 上报"当前查看的对话"（/dingo.set-current-session）。
 *
 * @module dsh-dingo/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// shell.overlay 槽位由 dsh-client-ui-layout 声明；type-only 导入加载 SlotMap 增强
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { FeedbackCard, type FeedbackCardProps } from './FeedbackCard.tsx'

/** 客户端插件名（web server 按此 id 注册/卸载）。 */
export const name = 'dsh-dingo-client'

/** 客户端所需服务：槽位系统、文案命名空间、Connection（含 /dingo RPC）。 */
export const inject = ['slots', 'locale', 'connection'] as const

/** 客户端文案命名空间（无自定义文案时用内置）。 */
export const LOCALE_NS = 'dingo'

/**
 * 注册提醒卡片（shell.overlay 全局浮层）。
 * useSessions 由框架标准 props 注入（读取当前打开的对话）。
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const rpc = connection.rpc
  // 会话跳转服务：卡片点击 → 直接打开对应对话（与侧边栏点击同一入口）。
  // 注意：open 要求会话在列表内；未知/已删除会话会抛错，这里静默忽略。
  const sessions = ctx.get('sessions') as { open(id: string): void } | undefined

  ctx.effect(() => {
    return ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'dsh-dingo-feedback',
      order: 50,
      inject: () => ({
        rpc,
        openSession: (sessionId: string) => {
          try {
            sessions?.open(sessionId)
          } catch {
            // 会话已不在列表（删除/归档）→ 静默；卡片照常关闭
          }
        },
      }),
    }, FeedbackCard as unknown as (props: FeedbackCardProps) => JSX.Element))
  }, 'dsh-dingo: feedback card slot')
}
