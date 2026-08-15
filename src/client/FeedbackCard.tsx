/**
 * FR-6 插播通知卡片（client，可选 UI 面）。
 *
 * 职责（与 host 反馈引擎 {@link dsh-localvoice/feedback} 配套）：
 * - 轮询 `/voice.feedback {action:'announcements'}` 取插播队列快照，渲染
 *   全局 toast（分类徽标 + 播报文本 + 工作区/会话名）；
 * - 发现新「speaking」项 → 播放对应内置提示音（assets/ 生成的 data URL，
 *   **不占用 TTS 合成通道**，FR-6.2）；
 * - 「spoken」上报：speaking 项从快照消失 → 调 `/voice.feedback
 *   {action:'spoken', id}`，host 据此恢复正文并播下一条（轮询启发式；
 *   T-8 接 client Playback 播完钩子后精确化）；
 * - 关闭（dismiss）/ 重播（replay）按钮；
 * - 本组件挂载于 `shell.overlay`（root 作用域 list 槽，浮层不挡交互）。
 *
 * 注意：播报文本的语音（TTS）由 host 侧 `state.speak` 驱动走同一
 * `/voice.pull` 通道，本卡片只做视觉 + 提示音 + 完成/打断上报。
 *
 * @module dsh-localvoice/client/FeedbackCard
 */
import { useEffect, useRef, useState } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { RpcCall } from './rpc.ts'
import { resolveToneUrl, type ToneStyle } from './tones.ts'

/** `/voice.feedback` 返回的插播项视图（host 形状的子集）。 */
export interface AnnouncementView {
  id: string
  category: 'need-confirm' | 'task-done' | 'task-error' | 'normal'
  priority: number
  tone: 'ding' | 'ding-ding' | 'dong' | 'none'
  text: string
  state: 'pending' | 'deferred' | 'speaking' | 'spoken'
  /** 事件所属会话 id（点击卡片跳转目标；缺省 = 不可跳转）。 */
  sessionId?: string
  /** 是否当前对话：只播提示音（本地音），不显示卡片。 */
  own?: boolean
  workspaceTitle?: string
  sessionTitle?: string
  source: string
  createdAt: number
  replayable: boolean
}

/** `/voice.feedback {action:'announcements'}` 响应快照。 */
export interface FeedbackSnapshotView {
  enabled: boolean
  dnd: boolean
  confirmNeverSilent: boolean
  quietNow: boolean
  activeSessionId?: string
  /** T-8 音效打磨：提示音档位（soft 柔和 / crisp 清脆），client 按此选音。 */
  toneStyle?: ToneStyle
  queue: AnnouncementView[]
  history: AnnouncementView[]
  lastSpoken?: AnnouncementView
}

/** 轮询间隔（ms）：插播出现到 toast 上屏的感知延迟。 */
const POLL_INTERVAL_MS = 1000

/** 卡片保留时长（ms）：播报完成后仍显示这么久，供点击跳转/关闭；之后自动消失。 */
const CARD_KEEP_MS = 30_000

/**
 * 定位"Session log 下载按钮"（对话区域右上角）：扫描按钮，匹配
 * aria-label/title/文本含 "session" + "log"。返回其左上角坐标与尺寸
 * （卡片锚定到按钮正下方）；找不到返回 undefined（卡片回退视口右上角）。
 */
function findSessionLogAnchor(): { left: number; top: number; width: number; height: number } | undefined {
  if (typeof document === 'undefined') return undefined
  const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
  for (const el of candidates) {
    const label = (
      (el.getAttribute('aria-label') ?? '')
      + (el.getAttribute('title') ?? '')
      + (el.textContent ?? '')
    ).toLowerCase()
    if (label.includes('session') && label.includes('log')) {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      }
    }
  }
  return undefined
}

/** 分类 → 徽标文案与样式 key。 */
const CATEGORY_META: Record<AnnouncementView['category'], { label: string; className: string }> = {
  'need-confirm': { label: '需回答', className: 'lv-fb--confirm' },
  'task-done': { label: '有回复', className: 'lv-fb--done' },
  'task-error': { label: '失败', className: 'lv-fb--error' },
  normal: { label: '通知', className: 'lv-fb--normal' },
}

/** 取文本前 max 个字（超长加省略号）。 */
function truncate(text: string, max: number): string {
  const t = (text ?? '').trim()
  if (t === '') return ''
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

/** 状态图标：已完成=绿色小方块；需回答=橙色问号；失败=红色感叹号；其它=圆点。 */
function CategoryIcon({ category }: { category: AnnouncementView['category'] }): JSX.Element {
  switch (category) {
    case 'task-done':
      return <span style={styles.iconDone} aria-label="有回复" />
    case 'need-confirm':
      return <span style={styles.iconConfirm}>?</span>
    case 'task-error':
      return <span style={styles.iconError}>!</span>
    default:
      return <span style={styles.iconNormal} />
  }
}

/** FeedbackCard 注入面：/dingo RPC 调用器 + 会话跳转 + 会话快照（框架注入）。 */
export interface FeedbackCardProps {
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

/** 播放一段内置提示音（data URL；失败静默；T-8 按档位选音）。 */
function playTone(tone: AnnouncementView['tone'], style: ToneStyle | undefined): void {
  if (tone === 'none') return
  const url = resolveToneUrl(style, tone)
  if (!url) return
  const audio = new Audio(url)
  void audio.play().catch(() => {})
}

/** 注入一次卡片 hover 样式（内联 style 不支持 :hover；浏览器环境才执行）。 */
let hoverStylesInjected = false
function ensureHoverStyles(): void {
  if (hoverStylesInjected || typeof document === 'undefined') return
  hoverStylesInjected = true
  const style = document.createElement('style')
  style.textContent = [
    '.lv-fb__toast { transition: background 0.15s ease, border-color 0.15s ease; }',
    '.lv-fb__toast:hover { background: rgba(24,26,32,0.96) !important; border-color: rgba(120,140,180,0.55); }',
    '.lv-fb__toast[role="button"] { cursor: pointer; }',
  ].join('\n')
  document.head.appendChild(style)
}

/**
 * 插播通知卡片：全局 toast 浮层（注册进 `shell.overlay`）。
 * 视觉层 + 提示音 + spoken 上报；host 决策层（队列/去重/DND）不动。
 */
export function FeedbackCard({ rpc, openSession: openTarget, useSessions }: FeedbackCardProps): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<FeedbackSnapshotView | undefined>(undefined)
  /** 当前打开的对话（框架注入；上报 host 用于"当前对话叮/叮叮"判定）。 */
  const currentSessionId = useSessions?.((s) => s.current)
  /** 各会话 displayTitle（与侧边栏同一数据源；host 标题缺失时卡片兜底显示）。 */
  const sessionTitles = useSessions?.((s) => s.byId)
  // 已播放过提示音的 speaking 项（每 id 一次）
  const tonePlayed = useRef(new Set<string>())
  // 见过 speaking 的项（speaking → 消失 的过渡只报一次 spoken）
  const seenSpeaking = useRef(new Set<string>())
  const reportedSpoken = useRef(new Set<string>())
  // 本地卡片缓存：id → { item, seenAt }。播报完成/快照消失后仍保留显示
  // CARD_KEEP_MS 秒（卡片是"待处理提醒"，不该跟语音播报一起消失），
  // 直到用户点击跳转 / × 关闭 / 超时自动清理。
  const [cards, setCards] = useState<Map<string, { item: AnnouncementView; seenAt: number }>>(new Map())
  // Session log 按钮锚点（对话区域右上角；找不到 = undefined → 回退视口右上角）。
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number; height: number } | undefined>(undefined)
  // 被拖离默认位置（右上角栈）的卡片：id → fixed 坐标（viewport）。
  const [offsets, setOffsets] = useState<Record<string, { left: number; top: number }>>({})
  // 正在拖动的卡片 id（拖动中高亮样式）。
  const [draggingId, setDraggingId] = useState<string | undefined>(undefined)
  // 当前拖拽会话（down → move/up）。
  const dragRef = useRef<{
    id: string
    startX: number
    startY: number
    anchor: { left: number; top: number }
    moved: boolean
  } | null>(null)

  /** 移除一张本地卡片（关闭/跳转/超时共用）。 */
  const removeCard = (id: string): void => {
    setCards((prev) => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }

  /** 拖动开始：按钮区除外；记录起点锚点（已拖过用现偏移，否则用当前 rect）。 */
  const onDragStart = (event: React.PointerEvent<HTMLDivElement>, id: string): void => {
    if ((event.target as HTMLElement).closest('button')) return // 按钮区不启动拖动
    event.preventDefault() // 防文本选择/触摸滚动
    const rect = event.currentTarget.getBoundingClientRect()
    dragRef.current = {
      id,
      startX: event.clientX,
      startY: event.clientY,
      anchor: offsets[id] ?? { left: rect.left, top: rect.top },
      moved: false,
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 环境不支持 capture：退化为不捕获（move/up 仍需在卡片内发生）
    }
  }

  const onDragMove = (event: React.PointerEvent<HTMLDivElement>, id: string): void => {
    const drag = dragRef.current
    if (drag === null || drag.id !== id) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 5) {
      drag.moved = true
      setDraggingId(id)
    }
    if (drag.moved) {
      setOffsets((prev) => ({ ...prev, [id]: { left: drag.anchor.left + dx, top: drag.anchor.top + dy } }))
    }
  }

  /** 拖动结束：移动超阈值 = 已拖动（不跳转）；否则视为轻点 → 跳转对话。 */
  const onDragEnd = (event: React.PointerEvent<HTMLDivElement>, id: string, item: AnnouncementView): void => {
    const drag = dragRef.current
    dragRef.current = null
    setDraggingId(undefined)
    if (drag === null || drag.id !== id) return
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // noop
    }
    if (!drag.moved) handleOpenSession(item)
  }

  /** 点击卡片本体 → 跳到对应对话（无 sessionId 的卡片不可跳转）。 */
  const handleOpenSession = (item: AnnouncementView): void => {
    if (item.sessionId === undefined || item.sessionId === '') return
    // 跳转：client 侧直接打开对应会话（sessions.open，apply 注入），
    // 与侧边栏点击同一入口；之前只调 /dingo.switch 返回数据、从不真正打开。
    openTarget?.(item.sessionId)
    // 已处理：顺带关闭卡片，避免残留提醒
    removeCard(item.id)
    void rpc.call('/dingo', 'feedback', { action: 'dismiss', id: item.id })
  }

  useEffect(() => {
    let stopped = false
    ensureHoverStyles()

    async function poll(): Promise<void> {
      if (stopped) return
      try {
        const result = await rpc.call('/dingo', 'feedback', { action: 'announcements' })
        if (stopped) return
        if (result.ok && result.value !== undefined) {
          const next = result.value as FeedbackSnapshotView
          setSnapshot(next)
          // 刷新 Session log 按钮锚点（布局/切换对话后位置会变）
          setAnchor(findSessionLogAnchor())
          // 快照队列项 → 本地卡片缓存（首次见到记录 seenAt；已存在则刷新数据不重置计时）
          const nowMs = Date.now()
          setCards((prev) => {
            const out = new Map(prev)
            for (const item of next.queue) {
              const existing = out.get(item.id)
              out.set(item.id, existing === undefined
                ? { item, seenAt: nowMs }
                : { item, seenAt: existing.seenAt })
            }
            // 超时清理：播完/消失后保留 CARD_KEEP_MS 秒，之后自动移除
            for (const [id, entry] of out) {
              if (nowMs - entry.seenAt > CARD_KEEP_MS) out.delete(id)
            }
            return out
          })
          const speakingIds = new Set(next.queue.filter((item) => item.state === 'speaking').map((item) => item.id))
          // speaking 项 → 首次见播放提示音 + 记录。
          // 音色按归属：当前对话（own）用 crisp 档（"当"），非当前对话用
          // soft 档（"叮"），都是 1 声=有回复 / 2 声=需回答。
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

  // 上报"当前查看的对话"：host 判定当前对话回复 → 叮/叮叮（crisp 档"当"），
  // 其他对话 → 另一声音（soft 档"叮"）+ 卡片。切换对话时实时上报。
  useEffect(() => {
    void rpc.call('/dingo', 'set-current-session', { sessionId: currentSessionId }).catch(() => {})
  }, [currentSessionId, rpc])

  if (snapshot === undefined || !snapshot.enabled) return null
  // 渲染本地卡片缓存（播完/快照消失后仍保留 CARD_KEEP_MS 秒，供点击/关闭）。
  // 当前对话（own）项只播提示音，不显示卡片（用户正在看该对话）。
  const items = [...cards.values()].map((entry) => entry.item).filter((item) => item.own !== true)
  if (items.length === 0) return null

  return (
    <div
      className="lv-fb"
      style={{
        ...styles.container,
        // 锚定到 Session log 下载按钮正下方（右边缘对齐按钮，向下排列）；
        // 找不到锚点时回退视口右上角
        ...(anchor !== undefined
          ? {
              top: anchor.top + anchor.height + 8,
              right: Math.max(8, window.innerWidth - (anchor.left + anchor.width)),
            }
          : {}),
      }}
    >
      {items.map((item) => {
        const offset = offsets[item.id]
        const dragging = draggingId === item.id
        return (
          <div
            key={item.id}
            className={`lv-fb__toast ${CATEGORY_META[item.category].className}`}
            style={{
              ...styles.toast,
              // 被拖走的卡片脱离右上角排列，固定在放下位置（其余卡片自动补位）
              ...(offset !== undefined ? { position: 'fixed', left: offset.left, top: offset.top } : {}),
              ...(dragging ? styles.toastDragging : {}),
            }}
            data-state={item.state}
            title={item.sessionId ? '轻点跳转到该对话，按住可拖动' : undefined}
            onPointerDown={(e) => onDragStart(e, item.id)}
            onPointerMove={(e) => onDragMove(e, item.id)}
            onPointerUp={(e) => onDragEnd(e, item.id, item)}
            onPointerCancel={() => {
              dragRef.current = null
              setDraggingId(undefined)
            }}
          >
            {/* 固定小卡片：状态图标 + 工作区名 + 对话标题前几字（不显示播报文本） */}
            <CategoryIcon category={item.category} />
            <span style={styles.body}>
              <span style={styles.workspace}>
                {truncate(item.workspaceTitle ?? '', 12) || '对话'}
              </span>
              <span style={styles.session}>
                {truncate(
                  item.sessionTitle
                    ?? (sessionTitles as Record<string, { displayTitle?: string }> | undefined)?.[item.sessionId ?? '']?.displayTitle
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
                event.stopPropagation() // 不触发卡片跳转
                removeCard(item.id)
                void rpc.call('/dingo', 'feedback', { action: 'dismiss', id: item.id })
              }}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** 内联样式（无样式系统依赖；宿主样式可覆盖 lv-fb 类）。 */
const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'fixed',
    right: 16,
    top: 64,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    zIndex: 1000,
    pointerEvents: 'auto',
  },
  toast: {
    // 固定长宽的小卡片（内容只显示工作区 + 对话标题，不随文本变长）
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: 200,
    minHeight: 56,
    boxSizing: 'border-box',
    // 半透明悬浮卡片：常态 0.78，hover 变实（hover 样式见 ensureHoverStyles）
    background: 'rgba(24, 26, 32, 0.78)',
    color: '#e8e8e8',
    borderRadius: 8,
    padding: '8px 10px',
    boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
    fontSize: 13,
    lineHeight: 1.4,
    cursor: 'pointer',
    border: '1px solid transparent',
    // 触摸拖动时不触发页面滚动/缩放
    touchAction: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  },
  // 状态图标
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
  // 拖动中的卡片：抬升阴影，提示正在拖动
  toastDragging: {
    boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
    zIndex: 1001,
  },
}
