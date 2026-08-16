/**
 * dsh-dingo 2.0 — 会话卡片 Rail（紧凑统计 + 悬浮详细面板）。
 *
 * 内嵌只保留一个小统计：
 * - 有未处理异常 → 红色闪烁；
 * - 无异常但有未处理疑问 → 橙色闪烁；
 * - 无异常/疑问但有待阅读结论 → 绿色闪烁；
 * - 全部处理完 → 不闪烁。
 * 鼠标悬停/点击后向下滑出详细卡片面板，显示完整工作区名、对话名和状态颜色。
 *
 * @module dsh-dingo/client/SessionCardRailCompact
 */
import { useEffect, useRef, useState } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { RpcCall } from './rpc.ts'
import { resolveToneUrl, type ToneStyle } from './tones.ts'

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

/** 注入一次卡片 hover / spinner / pulse 样式（内联 style 不支持 :hover / keyframes）。 */
let stylesInjected = false
function ensureStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = [
    '.lv-fb__full { transition: background 0.15s ease, border-color 0.15s ease; }',
    '.lv-fb__full:hover { filter: brightness(1.15); }',
    '@keyframes lv-fb-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }',
    '@keyframes lv-fb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }',
    '@keyframes lv-fb-border-pulse { 0%, 100% { box-shadow: 0 0 4px var(--lv-fb-pulse-color, transparent); } 50% { box-shadow: 0 0 14px var(--lv-fb-pulse-color, transparent); } }',
  ].join('\n')
  document.head.appendChild(style)
}

/** SessionCardRailCompact 注入面：/dingo RPC 调用器 + 会话跳转 + 会话快照（框架注入）。 */
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
}

/**
 * 紧凑统计 Rail：内嵌只显示一个统计胶囊，悬停/点击弹出详细卡片面板。
 */
export function SessionCardRailCompact({ rpc, openSession: openTarget, useSessions }: SessionCardRailCompactProps): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<FeedbackSnapshotView | undefined>(undefined)
  /** 当前打开的对话（框架注入；上报 host 用于"当前对话当/当当"判定）。 */
  const currentSessionId = useSessions?.((s) => s.current)
  /** 各会话 displayTitle（与侧边栏同一数据源；host 标题缺失时卡片兜底显示）。 */
  const sessionTitles = useSessions?.((s) => s.byId)
  // 已播放过提示音的 speaking 项（每 id 一次）
  const tonePlayed = useRef(new Set<string>())
  // 见过 speaking 的项（speaking → 消失 的过渡只报一次 spoken）
  const seenSpeaking = useRef(new Set<string>())
  const reportedSpoken = useRef(new Set<string>())
  // Rail 容器与悬浮面板状态
  const railRef = useRef<HTMLDivElement | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  /** 打开面板并重置 5 秒自动关闭计时。 */
  const openPanel = (): void => {
    setPanelOpen(true)
    resetCloseTimer()
  }

  /** 关闭面板并清除自动关闭计时。 */
  const closePanel = (): void => {
    setPanelOpen(false)
    if (closeTimer.current !== undefined) {
      clearTimeout(closeTimer.current)
      closeTimer.current = undefined
    }
  }

  /** 重置 5 秒自动关闭计时（鼠标在面板上互动时也会续期）。 */
  const resetCloseTimer = (): void => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      closeTimer.current = undefined
      setPanelOpen(false)
    }, 5000)
  }

  /** 点击卡片：执行中只跳转；结论态跳转并标记「正常」（已看过）。 */
  const handleOpenSession = (card: SessionCardView): void => {
    if (card.sessionId === undefined || card.sessionId === '') return
    openTarget?.(card.sessionId)
    if (card.status !== 'running') {
      void rpc.call('/dingo', 'feedback', { action: 'mark-seen', sessionId: card.sessionId }).catch(() => {})
    }
    closePanel()
  }

  /** 关闭完整面板里的卡片：仅移除本次卡片。 */
  const handleDismiss = (sessionId: string): void => {
    void rpc.call('/dingo', 'feedback', { action: 'dismiss-card', sessionId }).catch(() => {})
  }

  useEffect(() => {
    let stopped = false
    ensureStyles()

    async function poll(): Promise<void> {
      if (stopped) return
      try {
        const result = await rpc.call('/dingo', 'feedback', { action: 'announcements' })
        if (stopped) return
        if (result.ok && result.value !== undefined) {
          const next = result.value as FeedbackSnapshotView
          setSnapshot(next)
          const speakingIds = new Set(next.queue.filter((item) => item.state === 'speaking').map((item) => item.id))
          // speaking 项 → 首次见播放提示音 + 记录。
          for (const item of next.queue) {
            if (item.state !== 'speaking') continue
            seenSpeaking.current.add(item.id)
            if (item.tone !== 'none' && !tonePlayed.current.has(item.id)) {
              tonePlayed.current.add(item.id)
              playTone(item.tone, item.own === true ? 'crisp' : 'soft')
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
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [rpc])

  // 上报"当前查看的对话"：host 判定当前对话回复 → 当/当当（crisp 档），
  // 其他对话 → 另一声音（soft 档"叮"）+ 卡片；同时把当前结论态标记为「正常」。
  useEffect(() => {
    void rpc.call('/dingo', 'set-current-session', { sessionId: currentSessionId }).catch(() => {})
  }, [currentSessionId, rpc])

  // 点击面板外部自动收起。
  useEffect(() => {
    if (!panelOpen) return
    const onDown = (event: MouseEvent): void => {
      if (railRef.current && !railRef.current.contains(event.target as Node)) closePanel()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [panelOpen])

  // 卸载时清理自动关闭计时器。
  useEffect(() => {
    return () => {
      if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
    }
  }, [])

  if (snapshot === undefined || !snapshot.enabled) return null
  const items = snapshot.cards
  if (items.length === 0) return null

  const errors = items.filter((card) => card.status === 'error')
  const questions = items.filter((card) => card.status === 'question')
  const answers = items.filter((card) => card.status === 'answered')
  const running = items.filter((card) => card.status === 'running')
  const normal = items.filter((card) => card.status === 'normal')
  const needsTotal = errors.length + questions.length + answers.length
  const priority = errors.length > 0 ? 'error' : questions.length > 0 ? 'question' : answers.length > 0 ? 'answered' : undefined

  const priorityColor = priority === 'error' ? '#ef4444' : priority === 'question' ? '#f59e0b' : priority === 'answered' ? '#22c55e' : undefined
  const pulse = priority ? 'lv-fb-pulse 1s ease-in-out infinite' : undefined

  const summaryStyle: React.CSSProperties = {
    ...styles.summary,
    ...(priorityColor
      ? {
          borderColor: priorityColor,
          boxShadow: `0 0 10px ${priorityColor}`,
          animation: 'lv-fb-border-pulse 1s ease-in-out infinite',
          ['--lv-fb-pulse-color' as string]: priorityColor,
        }
      : {}),
  }

  return (
    <div
      ref={railRef}
      className="lv-fb-rail"
      style={styles.rail}
      onMouseEnter={openPanel}
      onMouseLeave={() => {
        // 不立即关闭：5 秒内保持，超时后自动关闭
      }}
    >
      <button
        type="button"
        style={summaryStyle}
        title="查看全部会话卡片"
        aria-label="会话卡片统计"
        onClick={() => {
          if (panelOpen) closePanel()
          else openPanel()
        }}
      >
        {priorityColor && (
          <span style={{ ...styles.dot, background: priorityColor, animation: pulse }} />
        )}
        {needsTotal > 0 && <span style={styles.count}>{needsTotal}</span>}
        {running.length > 0 && <span style={styles.spinner} />}
        {running.length > 0 && <span style={styles.count}>{running.length}</span>}
        {normal.length > 0 && <span style={{ ...styles.dot, ...styles.dotNormal }} />}
        {normal.length > 0 && <span style={styles.count}>{normal.length}</span>}
      </button>
      {panelOpen && (
        <div style={styles.panel} onMouseEnter={resetCloseTimer}>
          {items.map((card) => (
            <DetailedCard
              key={card.sessionId}
              card={card}
              sessionTitles={sessionTitles as Record<string, { displayTitle?: string }> | undefined}
              onOpen={handleOpenSession}
              onDismiss={handleDismiss}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** 悬浮面板里的详细卡片：彩色、完整工作区名 + 对话名 + 关闭。 */
function DetailedCard({
  card,
  sessionTitles,
  onOpen,
  onDismiss,
}: {
  card: SessionCardView
  sessionTitles?: Record<string, { displayTitle?: string }>
  onOpen: (card: SessionCardView) => void
  onDismiss: (sessionId: string) => void
}): JSX.Element {
  const title = card.sessionTitle ?? sessionTitles?.[card.sessionId]?.displayTitle ?? ''
  return (
    <div
      className={`lv-fb__full lv-fb--${card.status}`}
      style={{ ...styles.full, ...statusCardStyle(card.status) }}
      data-status={card.status}
      onClick={() => onOpen(card)}
    >
      <SessionStatusIcon status={card.status} />
      <span style={styles.body}>
        <span style={styles.workspace}>{truncate(card.workspaceTitle ?? '', 16) || '对话'}</span>
        <span style={styles.session}>{truncate(title, 20) || '（未命名对话）'}</span>
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

/** 内联样式（无样式系统依赖；宿主样式可覆盖 lv-fb 类）。 */
const styles: Record<string, React.CSSProperties> = {
  rail: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    flex: 'none',
  },
  summary: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 28,
    minWidth: 28,
    padding: '0 10px',
    borderRadius: 999,
    border: '1px solid rgba(120,140,180,0.35)',
    background: 'rgba(24, 26, 32, 0.7)',
    color: '#e8e8e8',
    fontSize: 11,
    lineHeight: 1,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
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
    fontSize: 11,
    fontWeight: 600,
    color: '#e8e8e8',
    lineHeight: 1,
  },
  panel: {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: 6,
    zIndex: 1100,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    minWidth: 260,
    maxHeight: '70vh',
    overflowY: 'auto',
    padding: 8,
    borderRadius: 10,
    background: 'rgba(20, 22, 28, 0.97)',
    boxShadow: '0 8px 30px rgba(0,0,0,0.45)',
  },
  full: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: 260,
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
    fontSize: 11,
    color: '#9aa3b2',
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
