/**
 * dsh-dingo — client half：会话卡片 Rail + 自动命名按钮 + 提示音播放。
 *
 * - 2.0 卡片 Rail 挂载到 `sidebar.footer.action`（侧边栏底部、设置上方；hero 页也可见）；
 * - 自动命名按钮挂载到会话头部操作行（`conversation.session.header.actions`，正 order）；
 * - 继续轮询 `/dingo.feedback` 消费声音层（speaking 提示音）与 1:1 卡片快照；
 * - 上报"当前查看的对话"（/dingo.set-current-session）。
 *
 * @module dsh-dingo/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// header actions 槽位由 dsh-client-ui-conversation 声明；sidebar foot 槽位由 dsh-client-ui-sidebar 声明；
// type-only 导入加载 SlotMap 增强
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { NarrowFloatingRail, WideFooterRail, type SessionCardRailCompactProps } from './SessionCardRailCompact.tsx'
import { AutoNameButton, type AutoNameButtonProps } from './AutoNameButton.tsx'
import { WorkspaceLabel, type WorkspaceLabelProps } from './WorkspaceLabel.tsx'
import { installDeepLink } from './deep-link.ts'

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
  /**
   * 软取客户端服务。
   *
   * 关键：**必须每次调用时现取**。apply 时 `uiWorkspace` 常常还没就绪
   * （实测同一页面里 apply 被调用多次，早期那次 `uiWorkspace` 是 undefined），
   * 一旦在闭包里把它捕获成 undefined，之后所有点击都变成哑弹。
   */
  const safeGet = <T,>(name: string): T | undefined => {
    try {
      return ctx.get(name) as T | undefined
    } catch {
      return undefined
    }
  }

  /**
   * 点击卡片 → 打开对应会话。
   *
   * 0.2 的入口是 `uiWorkspace.openSession(target)`；target 在实现里既接受
   * sessionId 字符串、也接受 `{ sessionId }` 形状（不同小版本不一致），
   * 所以两种都试；旧壳兜底 `sessions.open`。全失败才告警（不再静默吞掉）。
   */
  const openSession = (sessionId: string): void => {
    if (!sessionId) return
    const uiWorkspace = safeGet<{ openSession?: (target: unknown) => void }>('uiWorkspace')
    if (typeof uiWorkspace?.openSession === 'function') {
      try {
        uiWorkspace.openSession(sessionId)
        return
      } catch (first) {
        try {
          uiWorkspace.openSession({ sessionId })
          return
        } catch (second) {
          // eslint-disable-next-line no-console
          console.warn('[dsh-dingo] 会话跳转失败：', String(first), String(second))
        }
      }
    }
    const sessions = safeGet<{ open?: (id: string) => void }>('sessions')
    try {
      sessions?.open?.(sessionId)
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[dsh-dingo] sessions.open 失败：', String(error))
    }
  }
  // 会话输入服务：用于读取任意会话的未发送草稿。
  //
  // 契约限制（DSH 0.2）：`SessionInputResolver` 只对外承诺 `for(ctx)`，
  // `shell(sessionId)` 是内部 InputHub 的方法；而 `sessions.binding(id)` 只对
  // 客户端已 retain 的会话（基本就是当前会话）返回。所以这里**只能稳定拿到
  // 当前会话**的草稿，其它会话的草稿由组件里的模块级 Map 记住"离开时"的值
  // （见 SessionCardRailCompact 的 persistedDrafts）。
  const conversation = ctx.get('conversation') as {
    input: {
      for(actx: unknown): { state: { getSnapshot(): { draft: string } } }
      shell?(id: string): { state: { getSnapshot(): { draft: string } } }
    }
  } | undefined
  const getDraftBySession = (sessionId: string): string => {
    try {
      const sessions = safeGet<{ binding(id: string): { ctx: unknown } | undefined }>('sessions')
      const input = conversation?.input.shell?.(sessionId) ?? conversation?.input.for((sessions?.binding(sessionId) as { ctx: unknown } | undefined)?.ctx as never)
      return input?.state.getSnapshot()?.draft ?? ''
    } catch {
      return ''
    }
  }

  // 系统通知深链：dingOpen 参数 + 标签页复用（已有 DSH 标签页接管跳转并聚焦）
  // 条件放宽：0.2 可能没有 `sessions` 服务，导航走 uiWorkspace；深链本身不依赖它。
  ctx.effect(() => installDeepLink({
    openSession: (sessionId: string) => openSession(sessionId),
    channel: typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('dsh-dingo-deeplink') : undefined,
    closeWindow: () => window.close(),
  }), 'dsh-dingo: deeplink')

  // 上报 DSH Web UI 前台可见性：host 据此决定是否发系统通知
  // （可见 → 浏览器内提醒已够；不可见/未开 → 系统通知）。
  // 注意：页面刚加载时 document.hasFocus() 可能为 false（初始上报误报不可见），
  // 之后窗口已聚焦但 focus 事件不重发 → host 一直以为不可见 → 当前对话也弹系统通知。
  // 修复：值变化才上报 + 3s 定时兜底，保证状态最终一致。
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    let last: boolean | undefined
    const report = (): void => {
      const visible = document.visibilityState === 'visible' && document.hasFocus()
      if (visible === last) return
      last = visible
      void rpc.call('/dingo', 'set-visibility', { visible }).catch(() => {})
    }
    report()
    document.addEventListener('visibilitychange', report)
    window.addEventListener('focus', report)
    window.addEventListener('blur', report)
    const timer = setInterval(report, 3000)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', report)
      window.removeEventListener('focus', report)
      window.removeEventListener('blur', report)
    }
  }, 'dsh-dingo: visibility report')

  // 2.0 卡片 Rail：全局会话雷达 → 侧边栏底部（设置上方；折叠 rail 时压成小图标）。
  ctx.effect(() => {
    return ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'dsh-dingo-card-rail',
      // 负 order 排在最先：wrap 后独占第一行，Cordis / remote-web-ui 换到下一行。
      order: -100,
      inject: () => ({
        rpc,
        getDraftBySession,
        openSession: (sessionId: string) => openSession(sessionId),
      }),
    }, WideFooterRail as unknown as (props: SessionCardRailCompactProps) => JSX.Element))
  }, 'dsh-dingo: session card rail slot')

  // 窄屏（手机）：直接挂一个固定浮层。
  //
  // 为什么不用槽位：侧栏 footer 槽位在窄屏压根不挂载（侧栏是抽屉），而
  // `shell.overlay` 在不同壳版本里也不一定存在/挂载。这里用 ReactDOM 自己
  // 建一个 fixed 容器，跟壳的布局解耦，宽窄都稳。
  // 宽屏时组件内部返回 null（不轮询、不放音），桌面仍由侧栏那个实例负责。
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const host = document.createElement('div')
    host.id = 'dsh-dingo-floating-host'
    host.style.cssText = 'position:fixed;inset:0;z-index:9000;pointer-events:none'
    document.body.appendChild(host)
    const root = createRoot(host)
    root.render(createElement(NarrowFloatingRail as unknown as (props: SessionCardRailCompactProps) => JSX.Element, {
      rpc,
      getDraftBySession,
      openSession: (sessionId: string) => openSession(sessionId),
    }))
    return () => {
      try {
        root.unmount()
      } catch {
        // 已卸载
      }
      host.remove()
    }
  }, 'dsh-dingo: floating pill host')

  // 2.0 当前工作区标签：放在标准操作之后、Rename 之前。
  ctx.effect(() => {
    return ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'dsh-dingo-workspace-label',
      order: 40,
    }, WorkspaceLabel as unknown as (props: WorkspaceLabelProps) => JSX.Element))
  }, 'dsh-dingo: workspace label slot')

  // 2.0 自动命名按钮：放在工作区标签之后、卡片 Rail 左侧。
  ctx.effect(() => {
    return ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'dsh-dingo-auto-name',
      order: 50,
      inject: () => ({ rpc }),
    }, AutoNameButton as unknown as (props: AutoNameButtonProps) => JSX.Element))
  }, 'dsh-dingo: auto name button slot')
}