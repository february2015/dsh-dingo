/**
 * dsh-dingo 2.0 — 会话卡片 Rail（紧凑统计 + 悬浮详细面板）。
 *
 * 挂在侧边栏底部 `sidebar.footer.action`（设置上方，hero 首页也可见）。
 *
 * 内嵌只保留一个小统计：
 * - 有未处理异常 → 红色闪烁；
 * - 无异常但有未处理疑问 → 橙色闪烁；
 * - 无异常/疑问但有待阅读结论 → 绿色闪烁；
 * - 全部处理完 → 不闪烁。
 * 鼠标悬停/点击后向上滑出详细卡片面板，显示完整工作区名、对话名和状态颜色。
 * 侧边栏收起为 56px rail 时（wide=false）压成小点 + 数字的紧凑图标。
 *
 * @module dsh-dingo/client/SessionCardRailCompact
 */
import { useEffect, useRef, useState } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { RpcCall } from './rpc.ts'
import { resolveToneUrl, type ToneStyle } from './tones.ts'
import type { DingoSessionSummary } from '../types.ts'

/** `/dingo.feedback` 返回的插播项视图（host 形状的子集，声音层继续用）。 */
export interface AnnouncementView {
  id: string
  category: 'need-confirm' | 'task-done' | 'task-error' | 'normal'
  priority: number
  tone: 'ding' | 'ding-ding' | 'dong' | 'none'
  text: string
  state: 'pending' | 'deferred' | 'speaking' | 'spoken'
  sessionId?: string
  own?: boolean
  workspaceTitle?: string
  sessionTitle?: string
  source: string
  createdAt: number
  replayable: boolean
}

/** × 关闭一张合成卡后，同一种 summary 状态下不再立刻重新合成的时间窗（5 分钟）。 */
const SYNTHETIC_DISMISS_SUPPRESS_MS = 5 * 60_000

/** 面板空闲自动关闭（ms）：鼠标停着不动、也没在面板里操作时的兜底。 */
const PANEL_IDLE_CLOSE_MS = 5_000

/** 鼠标离开（胶囊与面板都出去了）后延迟关闭（ms）：给"移回面板"留一点时间。 */
const PANEL_LEAVE_CLOSE_MS = 2_000

/** 2.0 会话卡片状态。 */
export type SessionCardStatus = 'running' | 'answered' | 'question' | 'error' | 'normal'

/** 2.0 会话卡片视图（client 渲染数据源）。 */
export interface SessionCardView {
  sessionId: string
  status: SessionCardStatus
  workspaceTitle?: string
  sessionTitle?: string
  createdAt: number
  updatedAt: number
  conclusionAt?: number
  /** 执行中是否已经产生中间输出（有内容但未最终完成）。 */
  hasIntermediate?: boolean
  /** 该会话是否有 TaskSwarm 蜂群批次仍在运行。 */
  hasSwarm?: boolean
  /** 该会话 TaskSwarm 蜂群中各 Wave 未完成的 lane 数量（如 [3, 2]）。 */
  swarmWaveCounts?: number[]
}

/** `/dingo.feedback {action:'announcements'}` 响应快照。 */
export interface FeedbackSnapshotView {
  enabled: boolean
  dnd: boolean
  confirmNeverSilent: boolean
  quietNow: boolean
  activeSessionId?: string
  toneStyle?: ToneStyle
  queue: AnnouncementView[]
  history: AnnouncementView[]
  cards: SessionCardView[]
  lastSpoken?: AnnouncementView
}

/** 轮询间隔（ms）：状态变化到卡片上屏的感知延迟。 */
const POLL_INTERVAL_MS = 1000

/** 取文本前 max 个字（超长加省略号）。 */
function truncate(text: string, max: number): string {
  const t = (text ?? '').trim()
  if (t === '') return ''
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

/** 从路径取最后一段作为工作区名兜底。 */
function basename(path?: string): string | undefined {
  if (!path) return undefined
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : undefined
}

/**
 * DSH 的会话草稿存储前缀。
 *
 * 客户端把每个会话的输入框内容持久化在 `localStorage['dsh.conversation.<sessionId>']`
 * 的 `draft` 字段里（键名来自 `@deepseek-ai/dsh-client-ui-conversation` 的 `stores.ts`），
 * 所以这里**不需要 retain 任何会话**就能读到"所有会话的草稿"，也能跨标签页、跨刷新。
 */
const DRAFT_STORE_PREFIX = 'dsh.conversation.'

/**
 * 从持久化值里挖出草稿正文（兼容三种形状）。
 *
 * - 旧版：字符串本身就是正文；
 * - 现版：`{ draft: { text, references, ... } }`；
 * - 兜底：任意层级的 `{ draft }` / `{ text }` 递归。
 * @param value - `JSON.parse` 后的存储值。
 * @returns 草稿正文（无内容 → 空串）。
 */
export function draftTextFrom(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  if ('draft' in record) return draftTextFrom(record.draft)
  if (typeof record.text === 'string') return record.text
  return ''
}

/**
 * 读所有会话的草稿（sessionId → 正文）。
 *
 * 只回非空草稿；读不到/坏 JSON 一律跳过——草稿是辅助信息，不能因为它把轮询搞挂。
 * @returns 有内容的草稿表。
 */
export function readAllDrafts(): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof localStorage === 'undefined') return out
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key === null || !key.startsWith(DRAFT_STORE_PREFIX)) continue
      const raw = localStorage.getItem(key)
      if (raw === null) continue
      let text = ''
      try {
        text = draftTextFrom(JSON.parse(raw) as unknown)
      } catch {
        continue
      }
      if (text.trim() !== '') out[key.slice(DRAFT_STORE_PREFIX.length)] = text
    }
  } catch {
    return out
  }
  return out
}

/**
 * 面板锁定态（模块级：宽屏与窄屏两个实例、组件重挂载后都保持）。
 *
 * 锁定 = 不自动收起（移开鼠标、点面板外、5s 空闲都不收）；点胶囊或再点一次
 * "锁定"按钮才收。读它一律用这个模块变量，不用 React state——state 更新是异步的，
 * 收起判断里读到旧值会造成"锁了还在自动关"。
 */
let panelLocked = false

/** 2.0 状态图标：执行中=spinner；有答案=绿方块；有疑问=橙问号；有异常=红感叹号；正常=灰圆点。 */
function SessionStatusIcon({ status }: { status: SessionCardStatus }): JSX.Element {
  switch (status) {
    case 'running':
      return <span style={styles.iconRunning} aria-label="正在执行" />
    case 'answered':
      return <span style={styles.iconDone} aria-label="有答案" />
    case 'question':
      return <span style={styles.iconConfirm}>?</span>
    case 'error':
      return <span style={styles.iconError}>!</span>
    default:
      return <span style={styles.iconNormal} aria-label="正常" />
  }
}

/** 播放一段内置提示音（data URL；失败静默；按档位选音）。 */
function playTone(tone: AnnouncementView['tone'], style: ToneStyle | undefined): void {
  if (tone === 'none') return
  const url = resolveToneUrl(style, tone)
  if (!url) return
  const audio = new Audio(url)
  void audio.play().catch(() => {})
}

/** 注入一次卡片 hover / spinner / pulse / 呼吸样式（内联 style 不支持 :hover / keyframes）。 */
let stylesInjected = false
function ensureStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = [
    '.lv-fb__full { transition: background 0.15s ease, border-color 0.15s ease; }',
    '.lv-fb__full:hover { filter: brightness(1.15); }',
    // 图钉按钮：悬停提亮，键盘 Tab 到时有明确焦点环（内联样式做不了 :hover）。
    '.lv-fb-pin:hover { filter: brightness(1.3); }',
    '.lv-fb-pin:focus-visible { outline: 2px solid #f59e0b; outline-offset: 1px; }',
    '@keyframes lv-fb-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }',
    '@keyframes lv-fb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }',
    '@keyframes lv-fb-border-pulse { 0%, 100% { box-shadow: 0 0 4px var(--lv-fb-pulse-color, transparent); } 50% { box-shadow: 0 0 14px var(--lv-fb-pulse-color, transparent); } }',
    // 胶囊本体呼吸：scale + opacity，把注意力拉回侧边栏底部（普通档）。
    '@keyframes lv-fb-breathe { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.06); opacity: 0.85; } }',
    // 异常档：更快、幅度更大，最需要被看见。
    '@keyframes lv-fb-breathe-fast { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.1); opacity: 0.72; } }',
    // 尊重系统减弱动态：停掉胶囊、圆点、spinner 的一切动画与过渡。
    '@media (prefers-reduced-motion: reduce) { .lv-fb-rail, .lv-fb-rail * { animation: none !important; transition: none !important; } }',
  ].join('\n')
  document.head.appendChild(style)
}

/** 向上找最近的 flex-row 容器（footer 操作行；绕过可能存在的条目包装层）。 */
function findRowAncestor(el: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = el?.parentElement ?? null
  while (node) {
    const style = getComputedStyle(node)
    if (style.display.includes('flex') && (style.flexDirection === 'row' || style.flexDirection === 'row-reverse')) {
      return node
    }
    node = node.parentElement
  }
  return null
}

/**
 * SessionCardRailCompact 注入面：/dingo RPC 调用器 + 会话跳转 + 会话快照（框架注入）。
 * 挂在 `sidebar.footer.action`（list, root scope）：owner 只传 wide 折叠态；
 * 标准 props 提供 useSessions / useWorkspaces（root 槽通用），无 useInput ——
 * 当前会话草稿改由 getDraftBySession 直读输入快照。
 */
export interface SessionCardRailCompactProps {
  rpc: RpcCall
  /** 打开指定会话（卡片点击跳转；由 apply 注入，内部走 sessions.open）。 */
  openSession?: (sessionId: string) => void
  /**
   * 框架标准钩子：读取全局会话列表快照（标准 selector 形状）。
   * - `current`：当前打开的对话；
   * - `byId`：各会话 displayTitle（与侧边栏同一数据源，卡片标题兜底）。
   */
  useSessions?: <T>(selector: (s: SessionListState) => T) => T | undefined
  /** 读取任意会话的未发送草稿（由 client 入口注入）。 */
  getDraftBySession?: (sessionId: string) => string
  /** 侧边栏折叠态（false = 56px rail；此时压成紧凑小图标）。 */
  wide?: boolean
  /**
   * 挂载位置：
   * - 'footer'（默认）侧栏底部，宽屏用；
   * - 'overlay' `shell.overlay` 浮层，窄屏（手机）用 —— 侧栏是抽屉，
   *   footer 槽位在窄屏根本不会挂载，只能走全局浮层。
   */
  variant?: 'footer' | 'overlay'
}

/**
 * 排序：异常 > 疑问 > 草稿 > 待阅读 > 等待后台/子任务 > 中间输出 > 执行中 > 正常。
 *
 * 当前对话同样不参与"草稿/等待"这两档：那是提醒维度，你正看着它，没必要因为
 * 自己打字或自己起的后台任务把卡片顶到最前面。执行中的排序照旧。
 * @param card - 卡片。
 * @param isDraftFor - 该会话是否有未发送草稿。
 * @param isWaiting - 该会话是否还有后台/子任务在跑。
 * @param currentSessionId - 当前打开的会话（不参与提醒类排序）。
 * @returns 排序权重（越小越靠前）。
 */
export function cardRank(
  card: SessionCardView,
  isDraftFor?: (sessionId: string) => boolean,
  isWaiting?: (sessionId: string) => boolean,
  currentSessionId?: string,
): number {
  const isCurrent = card.sessionId === currentSessionId
  const isDraft = !isCurrent && (isDraftFor?.(card.sessionId) ?? false)
  const waiting = !isCurrent && (isWaiting?.(card.sessionId) ?? false)
  switch (card.status) {
    case 'error':
      return 0
    case 'question':
      return 1
    case 'answered':
      return 2
    case 'running':
      return isDraft ? 3 : card.hasIntermediate ? 5 : 6
    case 'normal':
      return isDraft ? 3 : waiting ? 4 : 7
    default:
      return 8
  }
}

/**
 * 统计互斥归桶：每个会话只进一个桶。
 *
 * 规则分两类：
 * - **提醒类**（异常/疑问/草稿/待阅读/等待后台）：当前对话不参与——你正看着它，
 *   红/橙/紫/绿这些"去看一眼"的信号没有意义，统一落中性 `normal`。
 * - **活动类**（执行中/中间输出）：当前对话**照实计入**。"它在跑"是客观状态而不是
 *   提醒，把它算成已读的话，侧栏底部就永远看不到当前会话在转（本次修正的正是这个）。
 * @param card - 卡片。
 * @param currentSessionId - 当前打开的会话。
 * @param isDraftFor - 该会话是否有未发送草稿。
 * @param isWaiting - 该会话是否还有后台/子任务在跑。
 * @returns 所属统计桶。
 */
export function summaryBucket(
  card: SessionCardView,
  currentSessionId?: string,
  isDraftFor?: (sessionId: string) => boolean,
  isWaiting?: (sessionId: string) => boolean,
): 'error' | 'question' | 'draft' | 'answered' | 'waiting' | 'intermediate' | 'running' | 'normal' | undefined {
  const isCurrent = card.sessionId === currentSessionId
  // 当前对话的非执行态一律归中性：提醒给你看的那些信号你已经看见了。
  if (isCurrent && card.status !== 'running') return 'normal'
  if (card.status === 'error') return 'error'
  if (card.status === 'question') return 'question'
  if (card.status === 'answered') return 'answered'
  // 草稿挂在"待阅读"之下、"已读/运行中"之上：它是提醒，但弱于"有结论要你看"。
  if (!isCurrent && (isDraftFor?.(card.sessionId) ?? false)) return 'draft'
  if (!isCurrent && (isWaiting?.(card.sessionId) ?? false) && card.status === 'normal') return 'waiting'
  if (card.status === 'running') return card.hasIntermediate ? 'intermediate' : 'running'
  if (card.status === 'normal') return 'normal'
  return undefined
}

/**
 * 读 DSH 持久化的"当前会话"选择。
 *
 * 键名与形状是小版本相关的实现细节（`dsh.sessions.current`，值是
 * `{ sessionId }` 或包了一层 `{ value: { sessionId } }`），所以这里按
 * "扫一遍以 sessions.current 结尾的键、再递归找 sessionId"来容错。
 * @returns 当前会话 id；读不到 → undefined。
 */
function readStoredCurrentSession(): string | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined
    const pick = (raw: string | null): string | undefined => {
      if (!raw) return undefined
      const parsed = JSON.parse(raw) as unknown
      const seen = new Set<unknown>()
      const dig = (node: unknown, depth: number): string | undefined => {
        if (depth > 4 || node === null || typeof node !== 'object' || seen.has(node)) return undefined
        seen.add(node)
        const record = node as Record<string, unknown>
        if (typeof record.sessionId === 'string' && record.sessionId !== '') return record.sessionId
        for (const value of Object.values(record)) {
          const hit = dig(value, depth + 1)
          if (hit !== undefined) return hit
        }
        return undefined
      }
      return dig(parsed, 0)
    }
    const direct = pick(localStorage.getItem('dsh.sessions.current'))
    if (direct !== undefined) return direct
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key !== null && key.endsWith('sessions.current')) {
        const hit = pick(localStorage.getItem(key))
        if (hit !== undefined) return hit
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** 存储读取结果的模块级缓存（渲染期每帧扫 localStorage 太贵，1s 内复用）。 */
let storedCurrentCache: { at: number; value: string | undefined } | undefined
const STORED_CURRENT_TTL_MS = 1000

/** 带缓存的 {@link readStoredCurrentSession}（仅作为 useSessions 缺席时的兜底）。 */
function readStoredCurrentSessionCached(): string | undefined {
  const now = Date.now()
  if (storedCurrentCache !== undefined && now - storedCurrentCache.at < STORED_CURRENT_TTL_MS) {
    return storedCurrentCache.value
  }
  const value = readStoredCurrentSession()
  storedCurrentCache = { at: now, value }
  return value
}

/**
 * 紧凑统计 Rail：内嵌只显示一个统计胶囊，悬停/点击弹出详细卡片面板。
 */
export function SessionCardRailCompact({ rpc, openSession: openTarget, useSessions, getDraftBySession, wide, variant = 'footer' }: SessionCardRailCompactProps): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<FeedbackSnapshotView | undefined>(undefined)
  /**
   * 当前打开的对话（上报 host 用于"当前对话当/当当"判定 + 卡片上的「当前」标签）。
   *
   * 槽位里挂的实例能拿到框架注入的 `useSessions`；但手机上的浮层实例是我们自己
   * 用 ReactDOM 挂的，拿不到这个 hook —— 那就读 DSH 自己持久化的选中项
   * （`localStorage` 的 `dsh.sessions.current`，就是侧栏那个"当前会话"），
   * 再兜底用 host 快照里回传的 activeSessionId。三层任一命中即可。
   */
  const storedCurrent = readStoredCurrentSessionCached()
  const currentSessionId = useSessions?.((s) => s.current) ?? storedCurrent ?? snapshot?.activeSessionId
  /** 各会话 displayTitle（与侧边栏同一数据源；host 标题缺失时卡片兜底显示）。 */
  const sessionTitles = useSessions?.((s) => s.byId)
  const allSessionIds = useSessions?.((s) => s.ids) ?? []
  /** 各会话后台任务（用于识别“等待后台/子任务”状态）。 */
  const jobsBySession = useSessions?.((s) => s.jobsBySession) ?? {}
  /** 当前会话输入框草稿（root 槽无 useInput，直读输入快照）；其它会话靠 localStorage。 */
  const currentDraft = getDraftBySession?.(String(currentSessionId ?? '')) ?? ''
  /**
   * 所有会话的草稿（sessionId → 正文），每轮 poll 从 localStorage 全量刷新。
   *
   * 不再依赖"本标签页打开过"：DSH 自己就把每个会话的输入提到 localStorage，
   * 所以你在任何会话里留几个字，这里都能立刻看到——这也正是"故意留草稿当 TODO"用法的基础。
   */
  const [drafts, setDrafts] = useState<Record<string, string>>(() => readAllDrafts())
  /**
   * 宿主会话清单（`/dingo.sessions`）。
   *
   * 侧栏槽位有 `useSessions`，但窄屏浮层胶囊是插件自己挂的 ReactDOM 实例，拿不到——
   * 没有这份清单，手机上"只有草稿、没有活跃事件"的会话就补不出来，标题也只剩「未命名」。
   */
  const [hostSessions, setHostSessions] = useState<readonly DingoSessionSummary[]>([])

  /** 判断某会话是否有后台任务/子任务仍在跑（主对话可能已完成）。 */
  const hasBackgroundWork = (sessionId: string): boolean => {
    const jobs = (jobsBySession as Record<string, readonly { status: string }[]>)[sessionId] ?? []
    if (jobs.some((job) => job.status === 'running' || job.status === 'stopping')) return true
    const summaries = (sessionTitles ?? {}) as Record<string, { parentId?: string; running?: boolean }>
    return Object.values(summaries).some((summary) => summary.parentId === sessionId && summary.running === true)
  }

  /** 某会话未完成后台任务数量（running/stopping）。 */
  const backgroundJobCount = (sessionId: string): number => {
    const jobs = (jobsBySession as Record<string, readonly { status: string }[]>)[sessionId] ?? []
    return jobs.filter((job) => job.status === 'running' || job.status === 'stopping').length
  }

  /**
   * 读取某会话的草稿：当前会话优先用活的输入快照（比落盘更即时），
   * 其它会话用 localStorage 里的持久化值。
   */
  const draftOf = (sessionId: string): string =>
    (sessionId === currentSessionId ? currentDraft : '') || drafts[sessionId] || ''
  const hasDraftFor = (sessionId: string): boolean => draftOf(sessionId).trim().length > 0

  /** poll 轮次计数（决定多久拉一次会话清单）。 */
  const pollTick = useRef(0)
  // 已播放过提示音的 speaking 项（每 id 一次）
  const tonePlayed = useRef(new Set<string>())
  // 见过 speaking 的项（speaking → 消失 的过渡只报一次 spoken）
  const seenSpeaking = useRef(new Set<string>())
  const reportedSpoken = useRef(new Set<string>())
  // × 关闭后的合成卡抑制：sessionId → 关闭时间戳。synth 卡会按
  // summary.running 每轮重新合成，若不加抑制，「× 关闭」看起来永远不好使。
  const syntheticDismissedAt = useRef(new Map<string, number>())
  // Rail 容器与悬浮面板状态
  const railRef = useRef<HTMLDivElement | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  // 窄屏（手机）：DSH 的侧栏是抽屉，药丸挂在 sidebar.footer 里基本看不到 →
  // 切成右上角固定浮层，点开是同一份跨项目卡片列表。
  const [narrowViewport, setNarrowViewport] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 900px)').matches
      : false,
  )
  const floating = variant === 'overlay' || narrowViewport
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
    const query = window.matchMedia('(max-width: 900px)')
    const sync = (): void => setNarrowViewport(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** 鼠标离开后的延迟关闭定时器（给"移到面板上"留一点时间）。 */
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** 锁定态（只用于渲染；判断逻辑一律读模块级 panelLocked）。 */
  const [locked, setLocked] = useState<boolean>(panelLocked)

  /**
   * 鼠标一进入胶囊就展开，没有延迟。
   *
   * 以前是"停留 700ms 才弹"，会让人觉得悬停没反应；现在弹出即时，收起交给三条
   * 明确节奏：移开约 2s、空闲 5s、点面板外立刻收；锁定时都不收。误触弹出也不怕——
   * 点别处（比如账号/设置）就没了。
   */
  const scheduleHoverOpen = (): void => {
    if (panelOpen) return
    cancelLeaveClose()
    openPanel()
  }

  /**
   * 鼠标离开后稍等再收起。
   *
   * 之前是"离开完全不收"，面板就一直挂在 footer 上方，把「设置 / 账号」
   * 那一排挡住点不到。现在移开 ~2s 就收（给手滑留缓冲）；移到面板上则取消这次收起；锁定时不收。
   */
  const scheduleLeaveClose = (): void => {
    if (panelLocked) return
    if (typeof leaveTimer.current !== 'undefined') clearTimeout(leaveTimer.current)
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = undefined
      closePanel()
    }, PANEL_LEAVE_CLOSE_MS)
  }

  /** 取消"离开关闭"（鼠标进到面板里了）。 */
  const cancelLeaveClose = (): void => {
    if (typeof leaveTimer.current !== 'undefined') {
      clearTimeout(leaveTimer.current)
      leaveTimer.current = undefined
    }
  }

  /** 清掉空闲自动关闭计时。 */
  const clearCloseTimer = (): void => {
    if (closeTimer.current !== undefined) {
      clearTimeout(closeTimer.current)
      closeTimer.current = undefined
    }
  }

  /**
   * 重置空闲自动关闭（锁定时不设）。
   *
   * 只要还有动作（鼠标在胶囊/面板里移动、移进面板）就续期；彻底没动作
   * {@link PANEL_IDLE_CLOSE_MS} 之后自动收起，避免面板长期挂在侧栏上。
   */
  const resetCloseTimer = (): void => {
    clearCloseTimer()
    if (panelLocked) return
    closeTimer.current = setTimeout(() => {
      closeTimer.current = undefined
      setPanelOpen(false)
    }, PANEL_IDLE_CLOSE_MS)
  }

  /** 打开面板并启动空闲关闭（锁定中则保持常开）。 */
  const openPanel = (): void => {
    setPanelOpen(true)
    resetCloseTimer()
  }

  /** 面板开着时的"还在看"续期（关着就什么都不做，避免空转定时器）。 */
  const keepAlive = (): void => {
    if (panelOpen) resetCloseTimer()
  }

  /** 关闭面板并清除自动关闭计时。 */
  const closePanel = (): void => {
    cancelLeaveClose()
    clearCloseTimer()
    setPanelOpen(false)
  }

  /** 锁定/解锁面板：锁定后不再自动收起。 */
  const toggleLock = (): void => {
    panelLocked = !panelLocked
    setLocked(panelLocked)
    if (panelLocked) {
      cancelLeaveClose()
      clearCloseTimer()
    } else {
      resetCloseTimer()
    }
  }

  /** 点击卡片：执行中只跳转；结论态跳转并标记「正常」（已看过）。 */
  const handleOpenSession = (card: SessionCardView): void => {
    if (card.sessionId === undefined || card.sessionId === '') return
    openTarget?.(card.sessionId)
    if (card.status !== 'running') {
      void rpc.call('/dingo', 'feedback', { action: 'mark-seen', sessionId: card.sessionId }).catch(() => {})
    }
    // 锁定时保持展开：这样可以连着点几个会话来回切换，面板不消失。
    if (!panelLocked) closePanel()
  }

  /** 关闭完整面板里的卡片：仅移除本次卡片（并临时抑制合成卡回生）。 */
  const handleDismiss = (sessionId: string): void => {
    syntheticDismissedAt.current.set(String(sessionId), Date.now())
    void rpc.call('/dingo', 'feedback', { action: 'dismiss-card', sessionId }).catch(() => {})
  }

  useEffect(() => {
    let stopped = false
    ensureStyles()

    async function poll(): Promise<void> {
      if (stopped) return
      // 会话清单变化慢（宿主 5s 一份），每 5 轮拉一次即可，省 RPC。
      pollTick.current += 1
      if (pollTick.current === 1 || pollTick.current % 5 === 0) {
        void rpc.call('/dingo', 'sessions', {})
          .then((response) => {
            if (stopped || !response.ok || response.value === undefined) return
            const value = response.value as { items?: readonly DingoSessionSummary[] }
            if (Array.isArray(value.items)) setHostSessions(value.items)
          })
          .catch(() => {})
      }
      try {
        const result = await rpc.call('/dingo', 'feedback', { action: 'announcements' })
        if (stopped) return
        if (result.ok && result.value !== undefined) {
          const next = result.value as FeedbackSnapshotView
          setSnapshot(next)
          // 草稿也在同一轮刷新：DSH 把输入落 localStorage，读全量即得"所有会话的草稿"。
          setDrafts(readAllDrafts())
          const speakingIds = new Set(next.queue.filter((item) => item.state === 'speaking').map((item) => item.id))
          // speaking 项 → 首次见播放提示音 + 记录。
          for (const item of next.queue) {
            if (item.state !== 'speaking') continue
            seenSpeaking.current.add(item.id)
            if (item.tone !== 'none' && !tonePlayed.current.has(item.id)) {
              tonePlayed.current.add(item.id)
              // 当前对话固定 crisp；其它对话用配置档位（toneStyle 缺省 soft）。
              playTone(item.tone, item.own === true ? 'crisp' : (next.toneStyle ?? 'soft'))
            }
          }
          // 曾 speaking、本轮已不 speaking（host 超时/上报后移除）→ 补报 spoken
          for (const id of seenSpeaking.current) {
            if (reportedSpoken.current.has(id)) continue
            if (!speakingIds.has(id)) {
              reportedSpoken.current.add(id)
              void rpc.call('/dingo', 'feedback', { action: 'spoken', id })
            }
          }
          // 集合修剪（防无限增长；保留最近 64 个）
          if (seenSpeaking.current.size > 64) {
            const keep = [...seenSpeaking.current].slice(-64)
            seenSpeaking.current = new Set(keep)
            tonePlayed.current = new Set([...tonePlayed.current].filter((id) => keep.includes(id)))
            reportedSpoken.current = new Set([...reportedSpoken.current].filter((id) => keep.includes(id)))
          }
        }
      } catch {
        // 瞬时错误：下一轮重试
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS)
    // 后台标签页的定时器会被浏览器节流（最狠时 1 分钟一次），一回到前台立刻补查：
    // 否则"切走时到达的提醒"要等下一个周期，那时 speaking 窗口早过了，提示音就丢了。
    const onWake = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void poll()
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onWake)
    if (typeof window !== 'undefined') window.addEventListener('focus', onWake)
    return () => {
      stopped = true
      clearInterval(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onWake)
      if (typeof window !== 'undefined') window.removeEventListener('focus', onWake)
    }
  }, [rpc])

  /**
   * 点面板外的任何地方 → 立刻收起（锁定中不收）。
   *
   * 这正是"点账号/设置"场景的解法：pointerdown 在捕获阶段先收到、先把面板收掉，
   * 随后账号弹层在干净的界面上展开，不会互相遮挡。点卡片跳会话时，卡片在面板内，
   * 由 handleOpenSession 负责收。
   */
  useEffect(() => {
    if (!panelOpen || typeof document === 'undefined') return () => {}
    const onPointerDown = (event: PointerEvent): void => {
      if (panelLocked) return
      const rail = railRef.current
      if (rail !== null && event.target instanceof Node && rail.contains(event.target)) return
      closePanel()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [panelOpen])

  // 上报"当前查看的对话"：host 判定当前对话回复 → 当/当当（crisp 档），
  // 其他对话 → 另一声音（soft 档"叮"）+ 卡片；同时把当前结论态标记为「正常」。
  useEffect(() => {
    void rpc.call('/dingo', 'set-current-session', { sessionId: currentSessionId }).catch(() => {})
  }, [currentSessionId, rpc])

  // 卸载时清理自动关闭计时器。
  useEffect(() => {
    return () => {
      if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
    }
  }, [])

  const snapshotAvailable = snapshot !== undefined && snapshot.enabled
  const items = snapshot?.cards ?? []

  // 补卡：host 卡片之外，客户端从会话快照补出「仍在活跃」的会话——
  // 执行中（running）、待你回答（pendingInteraction）、已完成未读（completed）、
  // 草稿、后台任务/子任务。重启后 host 卡片为空时，靠这层补卡让雷达立即可见。
  /** 会话信息：客户端 store（侧栏同源）优先，宿主 `/dingo.sessions` 兜底（浮层实例只有后者）。 */
  type SessionInfo = {
    displayTitle?: string
    cwd?: string
    origin?: string
    running?: boolean
    pendingInteraction?: 'approval' | 'plan-review' | 'question'
    completed?: boolean
  }
  const summaries = (sessionTitles ?? {}) as Record<string, SessionInfo>
  const hostById = new Map(hostSessions.map((item) => [item.sessionId, item]))
  const sessionInfoOf = (sessionId: string): SessionInfo | undefined => {
    const local = summaries[sessionId]
    const host = hostById.get(sessionId)
    if (local === undefined && host === undefined) return undefined
    return {
      displayTitle: local?.displayTitle ?? host?.title,
      cwd: local?.cwd ?? host?.cwd,
      origin: local?.origin ?? host?.origin,
      running: local?.running ?? host?.running,
      pendingInteraction: local?.pendingInteraction,
      completed: local?.completed,
    }
  }
  /** 判断是否内部会话（TaskSwarm Worker / 子代理），不参与用户卡片/统计。 */
  const isInternalSession = (sessionId: string): boolean => {
    const info = sessionInfoOf(sessionId)
    return info?.origin === 'subagent'
      || (typeof info?.cwd === 'string' && /[\\/]\.taskswarm[\\/]worktrees[\\/]/.test(info.cwd))
  }

  /** 候选会话 = 客户端列表 ∪ 宿主清单（去重；浮层实例的客户端列表为空）。 */
  const sessionIds = allSessionIds.length > 0
    ? [...new Set([...allSessionIds.map(String), ...hostSessions.map((item) => item.sessionId)])]
    : hostSessions.map((item) => item.sessionId)
  const syntheticCards: SessionCardView[] = []
  for (const sid of sessionIds) {
    const info = sessionInfoOf(sid)
    // 子代理/Worker 会话不进入卡片清单。
    if (isInternalSession(sid)) continue
    if (items.some((card) => card.sessionId === sid)) continue
    const hasDraft = hasDraftFor(sid)
    const hasJobs = hasBackgroundWork(sid)
    const needsReply = Boolean(info?.pendingInteraction)
    const busy = Boolean(info?.running)
    const doneUnread = Boolean(info?.completed)
    if (!hasDraft && !hasJobs && !needsReply && !busy && !doneUnread) continue
    // × 关闭后的合成卡抑制：summary 未翻转为干净之前，不再立刻把同一张卡
    // 重新合成出来（否则「关闭按钮不好使」——host 卡片删了，客户端又按
    // running 补一张，看起来 × 永远点不掉）。走得到这里说明至少还有一个
    // 活跃原因，所以只需判断抑制窗口是否过期。
    const dismissedAt = syntheticDismissedAt.current.get(sid)
    if (dismissedAt !== undefined) {
      if (Date.now() - dismissedAt < SYNTHETIC_DISMISS_SUPPRESS_MS) continue
      syntheticDismissedAt.current.delete(sid)
    }
    const status: SessionCardStatus = needsReply ? 'question' : busy ? 'running' : doneUnread ? 'answered' : 'normal'
    syntheticCards.push({
      sessionId: sid,
      status,
      workspaceTitle: info?.cwd ? basename(info.cwd) : undefined,
      sessionTitle: info?.displayTitle,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  }
  /** 卡片标题/工作区兜底表：客户端 store 优先，宿主清单补齐。 */
  const viewSessionInfo: Record<string, { displayTitle?: string; cwd?: string }> = { ...(sessionTitles ?? {}) }
  for (const host of hostSessions) {
    if (viewSessionInfo[host.sessionId] !== undefined) continue
    viewSessionInfo[host.sessionId] = { displayTitle: host.title, cwd: host.cwd }
  }

  // 防御性去重：避免同一个会话因 host 卡片 + 客户端补卡出现两张。
  const seenPanel = new Set<string>()
  const panelItems = [...items, ...syntheticCards].filter((card) => {
    if (seenPanel.has(card.sessionId)) return false
    seenPanel.add(card.sessionId)
    return true
  })

  // 等待状态 = 后台任务/子任务，或 TaskSwarm 蜂群批次。
  const isWaiting = (sessionId: string): boolean =>
    hasBackgroundWork(sessionId) || items.some((card) => card.sessionId === sessionId && card.hasSwarm)

  // 空态补位：快照就绪且启用即常显（即使没有活跃卡片）——
  // 刚重启/事件未产生时用灰点 + 0 占住雷达位；会话数由 barHint 反映。
  const showBar = snapshotAvailable

  // 展开态独占一行：找到所在 footer 操作行并允许换行，本胶囊 width:100% 占满首行，
  // Cordis / remote-web-ui 等其它条目自动换到下一行。依赖「条可见」——host 卡片
  // 加载前组件先渲染 null、DOM 未挂载，晚到卡片出现时才真正挂载，效果必须随之重跑。
  useEffect(() => {
    if (!showBar || wide === false) return
    const row = findRowAncestor(railRef.current)
    if (row === null) return
    const prev = row.style.flexWrap
    row.style.flexWrap = 'wrap'
    return () => {
      row.style.flexWrap = prev
    }
  }, [showBar, wide])

  if (!showBar) return null

  /** 某张卡片的统计桶（排序/计数/卡片配色共用同一判据）。 */
  const bucketOf = (card: SessionCardView) =>
    summaryBucket(card, currentSessionId, hasDraftFor, isWaiting)

  // 排序：草稿/后台等待/中间输出等 client 侧状态一起参与（当前对话不吃提醒类排序）。
  const sortedItems = [...panelItems].sort(
    (a, b) => cardRank(a, hasDraftFor, isWaiting, currentSessionId)
      - cardRank(b, hasDraftFor, isWaiting, currentSessionId),
  )

  // 互斥统计：每个会话只归入一个最高优先级桶。
  const counts = { error: 0, question: 0, draft: 0, answered: 0, waiting: 0, intermediate: 0, running: 0, normal: 0 }
  for (const card of panelItems) {
    const bucket = summaryBucket(card, currentSessionId, hasDraftFor, isWaiting)
    if (bucket) counts[bucket]++
  }
  const errors = counts.error
  const questions = counts.question
  const answers = counts.answered
  const running = counts.running
  const normal = counts.normal
  const waiting = counts.waiting
  const intermediate = counts.intermediate
  const otherDraftCount = counts.draft
  const needsTotal = errors + questions + answers
  const priority = errors > 0 ? 'error' : questions > 0 ? 'question' : answers > 0 ? 'answered' : otherDraftCount > 0 ? 'draft' : undefined
  const priorityCount = priority === 'draft' ? otherDraftCount : needsTotal

  const priorityColor = priority === 'error' ? '#ef4444' : priority === 'question' ? '#f59e0b' : priority === 'draft' ? '#a855f7' : priority === 'answered' ? '#22c55e' : undefined
  const pulse = priority ? 'lv-fb-pulse 1s ease-in-out infinite' : undefined
  // 呼吸动画与辉光脉动叠加：异常档更快更猛，其余优先级普通档。
  const breathing = priority === 'error'
    ? 'lv-fb-breathe-fast 1.2s ease-in-out infinite, lv-fb-border-pulse 0.8s ease-in-out infinite'
    : priority
      ? 'lv-fb-breathe 1.8s ease-in-out infinite, lv-fb-border-pulse 1s ease-in-out infinite'
      : undefined

  const summaryStyle: React.CSSProperties = {
    // 展开态为独立全宽条（summaryBar）；折叠 rail / 窄屏浮层时缩回紧凑小胶囊。
    ...(wide === false || floating ? styles.summaryRail : styles.summaryBar),
    ...(floating
      ? { boxShadow: '0 6px 20px rgba(0,0,0,0.45)', backdropFilter: 'blur(8px)' }
      : {}),
    ...(priorityColor
      ? {
          borderColor: priorityColor,
          boxShadow: `0 0 10px ${priorityColor}`,
          animation: breathing,
          ['--lv-fb-pulse-color' as string]: priorityColor,
        }
      : {}),
  }

  const railStyle: React.CSSProperties = {
    ...styles.rail,
    // 展开态占满整行（配合 flexWrap 换行），右缘只留 4px 空隙防贴边；
    // 折叠 rail 时 foot 区居中，不右挤。
    width: wide === false ? undefined : 'calc(100% - 4px)',
    marginLeft: wide === false ? 0 : undefined,
    // 窄屏：脱离侧栏，固定在视口右上角（侧栏抽屉关着也看得见）。
    ...(floating
      ? {
          position: 'absolute' as const,
          top: 10,
          right: 10,
          left: 'auto',
          zIndex: 9000,
          width: 'auto',
          // host 容器是 pointer-events:none 的全屏覆层，药丸自己要把点击收回来
          pointerEvents: 'auto' as const,
        }
      : {}),
  }

  return (
    <div
      ref={railRef}
      className="lv-fb-rail"
      style={railStyle}
      onMouseEnter={scheduleHoverOpen}
      onMouseLeave={scheduleLeaveClose}
      // 有动作就续期：鼠标在胶囊/面板上移动都算"还在看"，别把面板收掉。
      onPointerMove={keepAlive}
    >
      <button
        type="button"
        style={summaryStyle}
        title="查看全部会话卡片"
        aria-label="会话卡片统计"
        onClick={() => {
          if (panelOpen) {
            // 显示中点胶囊 = 明确要收起，锁定也一并解除（否则锁定像是卡死了）。
            if (panelLocked) {
              panelLocked = false
              setLocked(false)
            }
            closePanel()
          } else {
            openPanel()
          }
        }}
      >
        {/* 空态补位：没有活跃卡片（如刚重启、事件未产生）时，灰点 + 0 占住雷达位置。 */}
        {panelItems.length === 0 && (
          <span style={styles.unit}>
            <span style={{ ...styles.dot, ...styles.dotNormal }} />
            <span style={styles.count}>0</span>
          </span>
        )}
        {priorityColor && (
          <span style={styles.unit}>
            <span style={{ ...styles.dot, background: priorityColor, animation: pulse }} />
            {priorityCount > 0 && <span style={styles.count}>{priorityCount}</span>}
          </span>
        )}
        {running > 0 && (
          <span style={styles.unit}>
            <span style={styles.spinner} />
            <span style={styles.count}>{running}</span>
          </span>
        )}
        {intermediate > 0 && (
          <span style={styles.unit}>
            <span style={{ ...styles.dot, ...styles.dotIntermediate }} />
            <span style={styles.count}>{intermediate}</span>
          </span>
        )}
        {waiting > 0 && (
          <span style={styles.unit}>
            <span style={{ ...styles.dot, ...styles.dotWaiting }} />
            <span style={styles.count}>{waiting}</span>
          </span>
        )}
        {normal > 0 && (
          <span style={styles.unit}>
            <span style={{ ...styles.dot, ...styles.dotNormal }} />
            <span style={styles.count}>{normal}</span>
          </span>
        )}
        {/* 展开态全宽条：右侧补一个会话总数说明，避免长条留白。 */}
        {wide !== false && <span style={styles.barHint}>{panelItems.length} 个活跃会话</span>}
      </button>
      {panelOpen && (
        // 展开态面板与横条完全等宽（left/right 0 + 去掉 minWidth 撑宽）——
        // 永不越过条的右缘，任何侧边栏宽度下右侧都不会被遮掩/裁切；
        // rail 折叠态锚定小胶囊右缘、固定最小宽。
        <div
          style={{
            ...styles.panel,
            ...(floating
              ? {
                  left: 'auto',
                  right: 0,
                  top: '100%',
                  bottom: 'auto',
                  marginTop: 6,
                  marginBottom: 0,
                  minWidth: 0,
                  width: 'min(86vw, 320px)',
                  maxHeight: '60vh',
                }
              : wide === false
                ? { right: 0 }
                : { left: 0, right: 0, minWidth: 0 }),
          }}
          onMouseEnter={() => {
            cancelLeaveClose()
            resetCloseTimer()
          }}
          onMouseLeave={scheduleLeaveClose}
        >
          <div style={styles.panelHeader}>
            <span style={styles.panelHint}>{panelItems.length} 个会话</span>
            <button
              type="button"
              className="lv-fb-pin"
              style={{ ...styles.lock, ...(locked ? styles.lockOn : {}) }}
              title={locked ? '取消锁定（恢复自动收起）' : '锁定面板（一直展开，不自动收起）'}
              aria-label={locked ? '取消锁定' : '锁定面板'}
              aria-pressed={locked}
              onClick={(event) => {
                event.stopPropagation()
                toggleLock()
              }}
            >
              <PinIcon pinned={locked} />
            </button>
          </div>
          {sortedItems.length === 0 ? (
            <div style={styles.empty}>暂无活跃会话</div>
          ) : (
            sortedItems.map((card) => (
              <DetailedCard
                key={card.sessionId}
                card={card}
                sessionTitles={viewSessionInfo as Record<string, { displayTitle?: string }> | undefined}
                isCurrent={card.sessionId === currentSessionId}
                bucket={bucketOf(card)}
                draftText={bucketOf(card) === 'draft' ? draftOf(card.sessionId) : undefined}
                dsJobsCount={backgroundJobCount(card.sessionId)}
                swarmWaveCounts={card.swarmWaveCounts ?? []}
                onOpen={handleOpenSession}
                onDismiss={handleDismiss}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 图钉图标：未锁定 = 空心灰 + 微微歪着；已锁定 = 实心橙 + 钉正。
 *
 * 用内联 SVG 而不是 emoji：📌 在 macOS / Windows 上都是彩色位图，既没法表达
 * "钉上 / 没钉上"两种状态，也不跟随主题色和 currentColor。
 * @param pinned - 是否已锁定。
 */
function PinIcon({ pinned }: { pinned: boolean }): JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      style={{
        display: 'block',
        transform: pinned ? 'none' : 'rotate(-25deg)',
        transition: 'transform 0.15s ease',
      }}
    >
      <path
        d="M9 3h6l-1 5 3 3v2H7v-2l3-3-1-5z"
        fill={pinned ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M12 13v8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

/** 悬浮面板里的详细卡片：彩色、完整工作区名 + 对话名 + 关闭。 */
function DetailedCard({
  card,
  sessionTitles,
  isCurrent,
  bucket,
  draftText,
  dsJobsCount,
  swarmWaveCounts,
  onOpen,
  onDismiss,
}: {
  card: SessionCardView
  sessionTitles?: Record<string, { displayTitle?: string; cwd?: string }>
  isCurrent?: boolean
  bucket?: 'error' | 'question' | 'draft' | 'answered' | 'waiting' | 'intermediate' | 'running' | 'normal'
  /** 草稿正文（草稿卡上直接显示你留的那几个字，面板即待办清单）。 */
  draftText?: string
  dsJobsCount?: number
  swarmWaveCounts?: number[]
  onOpen: (card: SessionCardView) => void
  onDismiss: (sessionId: string) => void
}): JSX.Element {
  const title = card.sessionTitle ?? sessionTitles?.[card.sessionId]?.displayTitle ?? ''
  const cwd = sessionTitles?.[card.sessionId]?.cwd
  const workspaceTitle = card.workspaceTitle ?? (cwd ? basename(cwd) : undefined)
  return (
    <div
      className={`lv-fb__full lv-fb--${card.status}`}
      style={{
        ...styles.full,
        ...bucketCardStyle(bucket, card.status),
      }}
      data-status={card.status}
      onClick={() => onOpen(card)}
    >
      {isCurrent && <span style={styles.currentBar} />}
      {isCurrent && <span style={styles.currentTag}>当前</span>}
      <SessionStatusIcon status={card.status} />
      <span style={styles.body}>
        <span style={styles.workspace}>
          {truncate(workspaceTitle ?? '', 16) || '（无工作区）'}
          {dsJobsCount ? (
            <>
              <span style={styles.miniSpinner} />
              {dsJobsCount}
            </>
          ) : null}
          {dsJobsCount ? ' · ' : ''}
          {(swarmWaveCounts ?? []).map((count, index) => (
            <span key={index} style={styles.waveSeg}>
              {index > 0 ? '· ' : ''}
              {index === 0 && <span style={styles.miniSpinner} />}
              {count}
            </span>
          ))}
        </span>
        <span style={styles.session}>
          {truncate(title, 20) || '（未命名对话）'}
          {bucket === 'draft' ? ' ✎' : ''}
          {bucket === 'waiting' ? ' ⏳' : ''}
          {bucket === 'intermediate' ? ' ↻' : ''}
        </span>
        {/* 草稿卡多一行：直接显示你留下的内容，扫一眼就知道这条待办是什么。 */}
        {bucket === 'draft' && draftText !== undefined && draftText.trim() !== '' && (
          <span style={styles.draftLine}>✎ {truncate(draftText, 28)}</span>
        )}
      </span>
      <button
        type="button"
        title="关闭"
        aria-label="关闭"
        style={styles.close}
        onClick={(event) => {
          event.stopPropagation()
          onDismiss(card.sessionId)
        }}
      >
        ×
      </button>
    </div>
  )
}

/** 状态 → 卡片边框/背景色（不同颜色便于区分）。 */
function statusCardStyle(status: SessionCardStatus): React.CSSProperties {
  switch (status) {
    case 'running':
      return { borderColor: 'rgba(96,165,250,0.55)', background: 'rgba(30,41,59,0.92)' }
    case 'answered':
      return { borderColor: 'rgba(34,197,94,0.55)', background: 'rgba(20,50,35,0.92)' }
    case 'question':
      return { borderColor: 'rgba(245,158,11,0.6)', background: 'rgba(60,45,20,0.92)' }
    case 'error':
      return { borderColor: 'rgba(239,68,68,0.6)', background: 'rgba(60,25,25,0.92)' }
    default:
      return { borderColor: 'rgba(156,163,175,0.4)', background: 'rgba(40,42,48,0.92)' }
  }
}

/** 按互斥统计桶决定卡片视觉，保证“统计看到什么颜色，卡片就是什么颜色”。 */
function bucketCardStyle(
  bucket: 'error' | 'question' | 'draft' | 'answered' | 'waiting' | 'intermediate' | 'running' | 'normal' | undefined,
  fallback: SessionCardStatus,
): React.CSSProperties {
  switch (bucket) {
    case 'draft':
      return { borderColor: 'rgba(168,85,247,0.7)', background: 'rgba(60,30,70,0.92)' }
    case 'waiting':
      return { borderColor: 'rgba(20,184,166,0.7)', background: 'rgba(15,55,50,0.92)' }
    case 'intermediate':
      return { borderColor: 'rgba(34,211,238,0.6)', background: 'rgba(15,45,60,0.92)' }
    default:
      return statusCardStyle(bucket ?? fallback)
  }
}

/** 内联样式（无样式系统依赖；宿主样式可覆盖 lv-fb 类）。 */
const styles: Record<string, React.CSSProperties> = {
  rail: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    flex: 'none',
  },
  // 展开态：独立全宽条（footer 操作行换行后独占一行）。
  summaryBar: {
    display: 'inline-flex',
    alignItems: 'center',
    // 单元之间留 8px（数字后面有空隙）；图标与自身数字在同一 unit 内紧贴。
    gap: 8,
    width: '100%',
    boxSizing: 'border-box',
    height: 32,
    minWidth: 0,
    padding: '0 12px',
    borderRadius: 10,
    border: '1px solid rgba(120,140,180,0.35)',
    background: 'rgba(24, 26, 32, 0.7)',
    color: '#e8e8e8',
    fontSize: 13,
    lineHeight: 1,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    justifyContent: 'flex-start',
  },
  /** 一个「图标 + 数字」单元：内部紧贴，单元之间由 summaryBar 的 gap 分隔。 */
  unit: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 0,
    flex: 'none',
  },
  /** 折叠 rail（wide=false）时的紧凑形态：更窄的内边距。 */
  summaryRail: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    height: 24,
    minWidth: 24,
    padding: '0 6px',
    borderRadius: 999,
    border: '1px solid rgba(120,140,180,0.35)',
    background: 'rgba(24, 26, 32, 0.7)',
    color: '#e8e8e8',
    fontSize: 12,
    lineHeight: 1,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  /** 全宽条右端的会话总数提示（展开态；push 到最右避免留白）。 */
  barHint: {
    marginLeft: 'auto',
    fontSize: 12,
    color: '#9aa3b2',
    opacity: 0.75,
    whiteSpace: 'nowrap',
  },
  /** 面板空态文案（无活跃卡片时）。 */
  empty: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '14px 10px',
    textAlign: 'center',
    fontSize: 12,
    color: '#9aa3b2',
  },
  /** 面板顶栏：会话数 + 锁定开关。 */
  panelHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '6px 10px 0',
    flex: 'none',
  },
  panelHint: {
    fontSize: 11,
    color: '#9aa3b2',
  },
  /** 图钉按钮：22×22 圆形按钮，图标颜色由 currentColor 决定。 */
  lock: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 22,
    height: 22,
    padding: 0,
    borderRadius: 999,
    // 未锁定也要一眼看见：边框/图标都比原来的淡灰亮一档（深浅两套主题下都清楚）。
    border: '1px solid rgba(148,163,184,0.85)',
    background: 'rgba(148,163,184,0.12)',
    color: '#cbd5e1',
    lineHeight: 0,
    cursor: 'pointer',
  },
  /**
   * 已锁定：橙色。
   *
   * 不用蓝色——蓝在本插件里是"执行中"，会误读；橙色是"钉住了 / 需要留意"的语义，
   * 和状态色板里的疑问橙同源（#f59e0b），一眼能看出面板不会自己走。
   */
  lockOn: {
    borderColor: 'rgba(245,158,11,0.75)',
    background: 'rgba(245,158,11,0.18)',
    color: '#f59e0b',
  },
  dot: {
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
    flex: 'none',
  },
  dotNormal: {
    background: '#9ca3af',
  },
  dotWaiting: {
    background: '#14b8a6',
  },
  dotIntermediate: {
    background: '#22d3ee',
  },
  spinner: {
    display: 'inline-block',
    width: 10,
    height: 10,
    borderRadius: '50%',
    border: '2px solid rgba(120,140,180,0.4)',
    borderTopColor: '#60a5fa',
    animation: 'lv-fb-spin 0.8s linear infinite',
    boxSizing: 'border-box',
    flex: 'none',
  },
  count: {
    fontSize: 13,
    fontWeight: 600,
    color: '#e8e8e8',
    lineHeight: 1,
  },
  panel: {
    position: 'absolute',
    // 侧边栏底部席位：面板向上弹出（列有 overflow:hidden，向下会被裁）。
    bottom: '100%',
    right: 0,
    marginBottom: 6,
    zIndex: 1200,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    minWidth: 260,
    maxHeight: '70vh',
    overflowY: 'auto',
    // 无内边距：卡片撑满到面板边缘，与状态框完全同宽（卡片自身带内边距）。
    padding: 0,
    borderRadius: 10,
    background: 'rgba(20, 22, 28, 0.97)',
    boxShadow: '0 -8px 30px rgba(0,0,0,0.45)',
  },
  full: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    // 自适应面板宽（面板与横条等宽）；rail 折叠态面板用固定 minWidth 时仍可伸展。
    width: '100%',
    minWidth: 0,
    minHeight: 56,
    boxSizing: 'border-box',
    color: '#e8e8e8',
    borderRadius: 8,
    padding: '8px 10px',
    fontSize: 13,
    lineHeight: 1.4,
    cursor: 'pointer',
    border: '1px solid transparent',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  },
  currentBar: {
    position: 'absolute',
    left: 0,
    top: 8,
    bottom: 8,
    width: 4,
    borderRadius: 2,
    background: '#60a5fa',
  },
  currentTag: {
    position: 'absolute',
    top: 4,
    right: 26,
    fontSize: 10,
    fontWeight: 600,
    color: '#60a5fa',
    background: 'rgba(96,165,250,0.15)',
    padding: '1px 5px',
    borderRadius: 4,
    pointerEvents: 'none',
  },
  // 状态图标
  iconRunning: {
    flexShrink: 0,
    width: 14,
    height: 14,
    borderRadius: '50%',
    border: '2px solid rgba(120,140,180,0.4)',
    borderTopColor: '#60a5fa',
    animation: 'lv-fb-spin 0.8s linear infinite',
    boxSizing: 'border-box',
  },
  iconDone: {
    flexShrink: 0,
    width: 14,
    height: 14,
    borderRadius: 3,
    background: '#22c55e',
  },
  iconConfirm: {
    flexShrink: 0,
    width: 14,
    height: 14,
    borderRadius: '50%',
    background: 'rgba(245, 158, 11, 0.9)',
    color: '#1a1a1a',
    fontSize: 11,
    fontWeight: 700,
    lineHeight: '14px',
    textAlign: 'center',
  },
  iconError: {
    flexShrink: 0,
    width: 14,
    height: 14,
    borderRadius: '50%',
    background: 'rgba(239, 68, 68, 0.9)',
    color: '#fff',
    fontSize: 11,
    fontWeight: 700,
    lineHeight: '14px',
    textAlign: 'center',
  },
  iconNormal: {
    flexShrink: 0,
    width: 10,
    height: 10,
    borderRadius: '50%',
    background: '#9ca3af',
  },
  body: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  workspace: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    color: '#9aa3b2',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  miniSpinner: {
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
    border: '1.5px solid rgba(120,140,180,0.4)',
    borderTopColor: '#60a5fa',
    animation: 'lv-fb-spin 0.8s linear infinite',
    boxSizing: 'border-box',
    flex: 'none',
  },
  waveSeg: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
  },
  /** 草稿预览行（紫，配合草稿状态）。 */
  draftLine: {
    fontSize: 11,
    color: '#c084fc',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  session: {
    fontSize: 13,
    fontWeight: 600,
    color: '#e8e8e8',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  close: {
    flexShrink: 0,
    width: 18,
    height: 18,
    borderRadius: 4,
    border: 'none',
    background: 'transparent',
    color: '#9aa3b2',
    fontSize: 14,
    lineHeight: '16px',
    cursor: 'pointer',
    padding: 0,
  },
}

/** 视口是否窄屏（手机）。 */
function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 900px)').matches
      : false,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
    const query = window.matchMedia('(max-width: 900px)')
    const sync = (): void => setNarrow(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  return narrow
}

/**
 * 窄屏浮层入口：由 client 入口用 ReactDOM 挂一个 fixed 容器渲染。
 *
 * 宽屏直接不渲染 —— 那时药丸由侧栏 footer 的那个实例负责，避免同一个插件
 * 起两份轮询、放两次提示音。
 */
export function NarrowFloatingRail(props: SessionCardRailCompactProps): JSX.Element | null {
  const narrow = useNarrowViewport()
  if (!narrow) return null
  return <SessionCardRailCompact {...props} variant="overlay" />
}

/**
 * 宽屏入口：挂在侧栏 `sidebar.footer.action`。
 *
 * 窄屏不渲染 —— 侧栏在手机上是被推到画布外的抽屉，footer 实例照样会挂载并
 * 轮询；两个实例同时跑会重复放提示音、重复上报 spoken。所以这里对称地让
 * 宽屏实例在窄屏下退出。
 */
export function WideFooterRail(props: SessionCardRailCompactProps): JSX.Element | null {
  const narrow = useNarrowViewport()
  if (narrow) return null
  return <SessionCardRailCompact {...props} variant="footer" />
}
