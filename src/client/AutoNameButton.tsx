/**
 * dsh-dingo 2.0 — 对话自动命名按钮（client header actions 槽位）。
 *
 * 点击后调用 host RPC `/dingo.auto-name {sessionId}`，成功后提示新标题。
 *
 * @module dsh-dingo/client/AutoNameButton
 */
import { useState } from 'react'
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
  if (!sessionId) return null

  const handleClick = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await rpc.call('/dingo', 'auto-name', { sessionId })
      if (result.ok && result.value && typeof result.value === 'object' && 'title' in result.value) {
        const title = (result.value as { title?: string }).title
        if (title) window.alert(`已重命名为：${title}`)
        else window.alert('自动命名失败：未生成有效标题')
      } else {
        const message = (result.error as { message?: string } | undefined)?.message ?? '自动命名失败'
        window.alert(message)
      }
    } catch {
      window.alert('自动命名请求失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      title="自动命名此对话"
      aria-label="自动命名"
      style={styles.button}
      disabled={busy}
      onClick={() => void handleClick()}
    >
      {busy ? '…' : '名'}
    </button>
  )
}

const styles: Record<string, React.CSSProperties> = {
  button: {
    flex: 'none',
    height: 28,
    minWidth: 28,
    padding: '0 8px',
    borderRadius: 999,
    border: '1px solid rgba(120,140,180,0.35)',
    background: 'rgba(24, 26, 32, 0.7)',
    color: '#e8e8e8',
    fontSize: 12,
    fontWeight: 500,
    lineHeight: 1,
    letterSpacing: 0.5,
    cursor: 'pointer',
  },
}
