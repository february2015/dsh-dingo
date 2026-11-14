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

/**
 * 缺文件/读失败的负缓存（ms）。
 *
 * `cardViews()` 每秒都会给无标题的卡片补一次标题，而多数会话根本没有投影
 * 缓存文件——不记"这次没有"的话，每秒每条会话都要打一次必失败的 `statSync`。
 */
const MISS_TTL_MS = 30_000;

/** 文件 → 上次确认"没有/读不出"的时间。 */
const misses = new Map<string, number>();

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
  // 负缓存命中：这段时间内不再打必然失败的 stat（文件可能之后才被写出来）。
  const missedAt = misses.get(file);
  if (missedAt !== undefined) {
    if (Date.now() - missedAt < MISS_TTL_MS) return undefined;
    misses.delete(file);
  }
  try {
    const stat = statSync(file);
    misses.delete(file);
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
    // 文件不在/读不出：清掉可能过期的旧值，记一次负缓存。
    entries.delete(file);
    misses.set(file, Date.now());
    return undefined;
  }
}
