/**
 * dsh-dingo client — 会话深链 + 标签页复用。
 *
 * 系统通知点击 → 打开 `<webui>/?dingOpen=<base64url(sessionId)>`（dsh-ding 同款
 * 格式，Windows toast 点击直达用；macOS 系统通知无点击回调，不走深链）。
 * 本模块负责：
 * 1. 解析 URL `dingOpen` 参数（base64url → sessionId）；
 * 2. 标签页协作（BroadcastChannel）：新标签页加载深链时广播 hello，
 *    已有 DSH 标签页收到后 `sessions.open` + `window.focus()` 并回 ack，
 *    新标签页收到 ack 即 `window.close()`（避免堆标签页）；
 *    无已有标签页响应时，新标签页自己直达。
 *
 * @module dsh-dingo/client/deep-link
 */

/** 广播频道名（所有 DSH 标签页共享）。 */
export const DEEP_LINK_CHANNEL = 'dsh-dingo-deeplink';

/** 等待已有标签页响应的窗口（ms）。 */
const TAKEOVER_WAIT_MS = 300;

/** base64url → UTF-8 字符串（浏览器端）。 */
function fromBase64Url(value: string): string {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** 从 URL 解析深链会话 id（`dingOpen` base64url 参数；无则返回 undefined）。 */
export function sessionFromUrl(href: string): string | undefined {
  try {
    const url = new URL(href)
    const open = url.searchParams.get('dingOpen')
    if (open === null || open === '') return undefined
    const session = fromBase64Url(open)
    return session === '' ? undefined : session
  } catch {
    return undefined
  }
}

/** 去掉 URL 里的 `dingOpen` 参数（返回新 href；避免刷新后重复跳转）。 */
export function stripSessionParam(href: string): string {
  try {
    const url = new URL(href)
    url.searchParams.delete('dingOpen')
    return url.toString()
  } catch {
    return href
  }
}

/** 深链处理句柄（apply 内调用；返回清理函数）。 */
export interface DeepLinkDeps {
  /** 打开指定会话（sessions.open）。 */
  openSession: (sessionId: string) => void;
  /** 当前页面是否可关闭（window.close 可用时）。 */
  closeWindow?: () => void;
  /** 浏览器环境（默认取全局；测试注入 fake）。 */
  channel?: { postMessage(data: unknown): void; addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void; removeEventListener(type: 'message', fn: (e: { data: unknown }) => void): void };
  /** 延迟（测试可注入 0）。 */
  waitMs?: number;
}

/** 安装深链处理（幂等；页面加载时调用一次）。 */
export function installDeepLink(deps: DeepLinkDeps): () => void {
  const open = deps.openSession;
  const channel = deps.channel;
  if (channel === undefined) {
    // 无 BroadcastChannel 环境：直接按 URL 跳转
    const session = typeof window !== 'undefined' ? sessionFromUrl(window.location.href) : undefined;
    if (session !== undefined) {
      open(session);
      if (typeof history !== 'undefined') history.replaceState(null, '', stripSessionParam(window.location.href));
    }
    return () => {};
  }

  let stopped = false;
  const onMessage = (e: { data: unknown }): void => {
    const msg = e.data as { type?: string; sessionId?: string } | null;
    if (msg?.type !== 'hello' || typeof msg.sessionId !== 'string') return;
    // 已有标签页：接管跳转 + 聚焦 + 回 ack
    try {
      open(msg.sessionId);
    } catch {
      return;
    }
    window.focus();
    channel.postMessage({ type: 'ack', sessionId: msg.sessionId });
  };
  channel.addEventListener('message', onMessage);

  // 本页是否带深链目标
  const target = typeof window !== 'undefined' ? sessionFromUrl(window.location.href) : undefined;
  if (target === undefined) {
    return () => {
      stopped = true;
      channel.removeEventListener('message', onMessage);
    };
  }

  // 清理 URL 参数（避免刷新重复跳转）
  if (typeof history !== 'undefined') history.replaceState(null, '', stripSessionParam(window.location.href));

  // 广播 hello：若有已有标签页响应 ack，则由它接管（本页自关）
  let taken = false;
  const onAck = (e: { data: unknown }): void => {
    const msg = e.data as { type?: string; sessionId?: string } | null;
    if (msg?.type === 'ack' && msg.sessionId === target) taken = true;
  };
  channel.addEventListener('message', onAck);
  channel.postMessage({ type: 'hello', sessionId: target });

  const timeout = setTimeout(() => {
    if (stopped) return;
    channel.removeEventListener('message', onAck);
    if (taken) {
      deps.closeWindow?.(); // 已有标签页已跳转并聚焦 → 本页关闭
    } else {
      try {
        open(target);
      } catch {
        // 目标会话不可达：静默（用户仍在本页）
      }
    }
  }, deps.waitMs ?? TAKEOVER_WAIT_MS);

  return () => {
    stopped = true;
    clearTimeout(timeout);
    channel.removeEventListener('message', onMessage);
    channel.removeEventListener('message', onAck);
  };
}
