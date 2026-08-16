/**
 * dsh-dingo 2.0 — 会话卡片 Rail（client header actions 槽位）。
 *
 * 按 §13 挂载到 `conversation.session.header.actions`：
 * - 不再使用 `findSessionLogAnchor` / fixed 定位；
 * - 内嵌紧凑卡（状态图标 + 工作区·对话名，无关闭按钮）；
 * - 溢出时折叠为 `+N` 箭头，点开悬浮面板显示完整卡片（含 × 关闭）。
 *
 * @module dsh-dingo/client/SessionCardRail
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

/** 注入一次卡片 hover / spinner 样式（内联 style 不支持 :hover / keyframes）。 */
let stylesInjected = false
function ensureStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = [
    '.lv-fb__full { transition: background 0.15s ease, border-color 0.15s ease; }',
    '.lv-fb__full:hover { background: rgba(24,26,32,0.96) !important; border-color: rgba(120,140,180,0.55); }',
    '@keyframes lv-fb-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }',
  ].join('\n')
  document.head.appendChild(style)
}

/** SessionCardRail 注入面：/dingo RPC 调用器 + 会话跳转 + 会话快照（框架注入）。 */
export interface SessionCardRailProps {
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
 * 会话卡片 Rail：内嵌在对话头部操作行。
 * 数据源仍是 `/dingo.feedback` 的 1:1 卡片快照；这里只负责展示/折叠/交互。
 */
export function SessionCardRail({ rpc, openSession: openTarget, useSessions }: SessionCardRailProps): JSX.Element | null {
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
  // Rail 容器与折叠状态
  const railRef = useRef<HTMLDivElement | null>(null)
  const innerRef = useRef<HTMLDivElement | null>(null)
  const [hiddenCount, setHiddenCount] = useState(0)
  const [panelOpen, setPanelOpen] = useState(false)

  /** 点击卡片：执行中只跳转；结论态跳转并标记「正常」（已看过）。 */
  const handleOpenSession = (card: SessionCardView): void => {
    if (card.sessionId === undefined || card.sessionId === '') return
    openTarget?.(card.sessionId)
    if (card.status !== 'running') {
      void rpc.call('/dingo', 'feedback', { action: 'mark-seen', sessionId: card.sessionId }).catch(() => {})
    }
    setPanelOpen(false)
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

  // 溢出检测：始终渲染全部卡片，只有空间不足时才把后面的折叠为 +N。
  useEffect(() => {
    const el = innerRef.current
    if (!el) return

    const countFit = (children: HTMLElement[], width: number): number => {
      let count = 0
      for (const child of children) {
        if (child.offsetLeft + child.offsetWidth <= width) count++
        else break
      }
      return count
    }

    const measure = (): void => {
      const total = snapshot?.cards.length ?? 0
      if (total === 0) {
        setHiddenCount(0)
        return
      }
      const children = Array.from(el.querySelectorAll<HTMLElement>('[data-card-index]'))
      const rawFit = countFit(children, el.clientWidth)
      // 只有确实放不下时才预留箭头按钮空间，并且只折叠后面的卡片。
      const fit = rawFit < total ? countFit(children, Math.max(0, el.clientWidth - 36)) : rawFit
      setHiddenCount(Math.max(0, total - fit))
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [snapshot?.cards])

  // 点击面板外部自动收起。
  useEffect(() => {
    if (!panelOpen) return
    const onDown = (event: MouseEvent): void => {
      if (railRef.current && !railRef.current.contains(event.target as Node)) setPanelOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [panelOpen])

  if (snapshot === undefined || !snapshot.enabled) return null
  const items = snapshot.cards
  if (items.length === 0) return null

  return (
    <div ref={railRef} className="lv-fb-rail" style={styles.rail}>
      <div ref={innerRef} style={styles.railInner}>
        {items.map((card, index) => (
          <div
            key={card.sessionId}
            data-card-index={index}
            className={`lv-fb__compact lv-fb--${card.status}`}
            style={styles.compact}
            title={card.sessionId ? '点击跳转到该对话' : undefined}
            onClick={() => handleOpenSession(card)}
          >
            <SessionStatusIcon status={card.status} />
            <span style={styles.compactText}>
              {truncate(
                card.workspaceTitle
                  ?? (sessionTitles as Record<string, { displayTitle?: string }> | undefined)?.[card.sessionId]?.displayTitle
                  ?? '对话',
                6,
              )}
              {card.sessionTitle || (sessionTitles as Record<string, { displayTitle?: string }> | undefined)?.[card.sessionId]?.displayTitle
                ? `·${truncate(card.sessionTitle ?? (sessionTitles as Record<string, { displayTitle?: string }> | undefined)?.[card.sessionId]?.displayTitle ?? '', 8)}`
                : ''}
            </span>
          </div>
        ))}
      </div>
      {hiddenCount > 0 && (
        <button
          type="button"
          style={styles.more}
          aria-label={`展开全部卡片（+${hiddenCount}）`}
          onClick={(event) => {
            event.stopPropagation()
            setPanelOpen((value) => !value)
          }}
        >
          +{hiddenCount}
        </button>
      )}
      {panelOpen && (
        <div style={styles.panel}>
          {items.map((card) => (
            <div
              key={card.sessionId}
              className="lv-fb__full"
              style={styles.full}
              data-status={card.status}
              onClick={() => handleOpenSession(card)}
            >
              <SessionStatusIcon status={card.status} />
              <span style={styles.body}>
                <span style={styles.workspace}>{truncate(card.workspaceTitle ?? '', 12) || '对话'}</span>
                <span style={styles.session}>
                  {truncate(
                    card.sessionTitle
                      ?? (sessionTitles as Record<string, { displayTitle?: string }> | undefined)?.[card.sessionId]?.displayTitle
                      ?? '',
                    10,
                  ) || '（未命名对话）'}
                </span>
              </span>
              <button
                type="button"
                title="关闭"
                aria-label="关闭"
                style={styles.close}
                onClick={(event) => {
                  event.stopPropagation()
                  handleDismiss(card.sessionId)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 内联样式（无样式系统依赖；宿主样式可覆盖 lv-fb 类）。 */
const styles: Record<string, React.CSSProperties> = {
  rail: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    flex: 'none',
    maxWidth: '100%',
  },
  railInner: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    maxWidth: '100%',
    minWidth: 0,
    overflow: 'hidden',
    flex: '0 1 auto',
  },
  compact: {
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    maxWidth: 130,
    height: 28,
    padding: '0 8px',
    boxSizing: 'border-box',
    borderRadius: 999,
    background: 'rgba(24, 26, 32, 0.7)',
    color: '#e8e8e8',
    fontSize: 11,
    lineHeight: 1,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  },
  compactText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  more: {
    position: 'absolute',
    right: 0,
    top: '50%',
    transform: 'translateY(-50%)',
    zIndex: 1,
    height: 28,
    minWidth: 28,
    padding: '0 8px',
    borderRadius: 999,
    border: '1px solid rgba(120,140,180,0.35)',
    background: 'rgba(24, 26, 32, 0.7)',
    color: '#e8e8e8',
    fontSize: 11,
    cursor: 'pointer',
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
    minWidth: 220,
    padding: 8,
    borderRadius: 10,
    background: 'rgba(20, 22, 28, 0.96)',
    boxShadow: '0 8px 30px rgba(0,0,0,0.45)',
  },
  full: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: 220,
    minHeight: 56,
    boxSizing: 'border-box',
    background: 'rgba(24, 26, 32, 0.9)',
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
