/**
 * 会话标题兜底：直接读 DSH 的投影缓存（不依赖已移除的 apiProxy.sessions）。
 *
 * 0.2 起宿主把标题存在 `~/.dsh/storages/session_projcache/sessions/<id>.json`
 * 的 `record.rows.title.val`，一个会话一个文件、JSON 明文、通常几 KB。
 * 跨工作区的会话不走当前客户端的 session store，标题只能从这里补。
 *
 * 带 mtime+size 缓存，只有文件变了才重读。
 *
 * @module dsh-dingo/session-titles
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface CacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly title: string | undefined;
}

const entries = new Map<string, CacheEntry>();

/** 投影缓存目录（默认 `~/.dsh/storages/session_projcache/sessions`）。 */
export function projectionCacheDir(home: string = homedir()): string {
  return join(home, '.dsh', 'storages', 'session_projcache', 'sessions');
}

/**
 * 读一个会话的标题（用户改过的或自动命名过的）。
 * @param sessionId - 会话 id。
 * @param dir - 投影缓存目录（缺省 {@link projectionCacheDir}）。
 * @returns 标题文本；没有/不可读 → undefined。
 */
export function sessionTitleFromCache(sessionId: string, dir: string = projectionCacheDir()): string | undefined {
  if (!sessionId) return undefined;
  const file = join(dir, `${sessionId}.json`);
  try {
    const stat = statSync(file);
    const hit = entries.get(file);
    if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.title;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      record?: {
        rows?: {
          title?: { val?: unknown };
          /** 标题输入投影：首条消息（没命名过的会话靠它兜底）。 */
          titleInput?: { val?: { first?: { text?: unknown } } };
        };
      };
    };
    const rows = parsed?.record?.rows;
    const raw = rows?.title?.val;
    let title = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
    if (title === undefined) {
      // 没命名过：用首条消息截一段，别让卡片停在「未命名对话」
      const first = rows?.titleInput?.val?.first?.text;
      if (typeof first === 'string') {
        const text = first.replace(/\s+/g, ' ').trim();
        if (text !== '') title = text.length > 24 ? `${text.slice(0, 24)}…` : text;
      }
    }
    entries.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, title });
    return title;
  } catch {
    return entries.get(file)?.title;
  }
}
