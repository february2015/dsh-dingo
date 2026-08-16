/**
 * dsh-dingo 2.0 — 对话自动命名按钮（client header actions 槽位）。
 *
 * 点击后调用 host RPC `/dingo.auto-name {sessionId}`，成功后显示短暂 toast 提示。
 *
 * @module dsh-dingo/client/AutoNameButton
 */
import { useEffect, useRef, useState } from 'react'
import type { RpcCall } from './rpc.ts'

/** AutoNameButton 注入面。 */
export interface AutoNameButtonProps {
  rpc: RpcCall
  /** 当前会话 id（header actions 框架注入；缺失时按钮不可用）。 */
  sessionId?: string
}

/** 对话头部「自动命名」按钮。 */
export function AutoNameButton({ rpc, sessionId }: AutoNameButtonProps): JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  if (!sessionId) return null

  /** 显示一条 3 秒后自动消失的小提示。 */
  const showToast = (message: string): void => {
    setToast(message)
    if (toastTimer.current !== undefined) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => {
      toastTimer.current = undefined
      setToast(null)
    }, 3000)
  }

  useEffect(() => {
    return () => {
      if (toastTimer.current !== undefined) clearTimeout(toastTimer.current)
    }
  }, [])

  const handleClick = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await rpc.call('/dingo', 'auto-name', { sessionId })
      if (result.ok && result.value && typeof result.value === 'object' && 'title' in result.value) {
        const title = (result.value as { title?: string }).title
        if (title) showToast(`已重命名为：${title}`)
        else showToast('自动命名失败：未生成有效标题')
      } else {
        const message = (result.error as { message?: string } | undefined)?.message ?? '自动命名失败'
        showToast(message)
      }
    } catch {
      showToast('自动命名请求失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={styles.wrapper}>
      <button
        type="button"
        title="自动命名此对话"
        aria-label="自动命名"
        style={styles.button}
        disabled={busy}
        onClick={() => void handleClick()}
      >
        {busy ? '…' : 'Rename'}
      </button>
      {toast && (
        <div style={styles.toast} role="status">
          {toast}
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
  },
  button: {
    flex: 'none',
    height: 28,
    minWidth: 28,
    padding: '0 10px',
    borderRadius: 999,
    border: '1px solid rgba(120,140,180,0.35)',
    background: 'rgba(24, 26, 32, 0.7)',
    color: '#e8e8e8',
    fontSize: 12,
    fontWeight: 500,
    lineHeight: 1,
    letterSpacing: 0.5,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  toast: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    right: 0,
    zIndex: 1200,
    maxWidth: 260,
    padding: '6px 10px',
    borderRadius: 8,
    background: 'rgba(20, 22, 28, 0.97)',
    color: '#e8e8e8',
    fontSize: 12,
    lineHeight: 1.4,
    boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    pointerEvents: 'none',
  },
}
