/**
 * dsh-dingo 2.0 — 当前工作区名称标签（client header actions 槽位）。
 *
 * 显示在当前对话的模式/标准操作之后、Rename 按钮之前，方便快速确认当前对话属于哪个工作区。
 *
 * @module dsh-dingo/client/WorkspaceLabel
 */
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'

/** WorkspaceLabel 注入面。 */
export interface WorkspaceLabelProps {
  /** 全局会话列表快照。 */
  useSessions?: <T>(selector: (s: SessionListState) => T) => T | undefined
  /** 全局工作区列表快照。 */
  useWorkspaces?: <T>(selector: (s: WorkspaceListState) => T) => T | undefined
}

/** 当前工作区标签。 */
export function WorkspaceLabel({ useSessions, useWorkspaces }: WorkspaceLabelProps): JSX.Element | null {
  const currentSessionId = useSessions?.((s) => s.current)
  const sessionTitles = useSessions?.((s) => s.byId)
  const workspaces = useWorkspaces?.((s) => s.items) ?? []
  if (!currentSessionId) return null

  const workspace = workspaces.find((item) => item.sessionIds.includes(currentSessionId))
  const cwd = (sessionTitles as Record<string, { cwd?: string }> | undefined)?.[currentSessionId]?.cwd
  const label = workspace?.title ?? (cwd ? basename(cwd) : undefined)
  if (!label) return null

  return (
    <span style={styles.label} title={workspace?.path ?? label}>
      {truncate(label, 14)}
    </span>
  )
}

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

const styles: Record<string, React.CSSProperties> = {
  label: {
    display: 'inline-flex',
    alignItems: 'center',
    height: 28,
    padding: '0 10px',
    borderRadius: 999,
    border: '1px solid rgba(120,140,180,0.25)',
    background: 'rgba(24, 26, 32, 0.5)',
    color: '#9aa3b2',
    fontSize: 12,
    lineHeight: 1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: 160,
  },
}
