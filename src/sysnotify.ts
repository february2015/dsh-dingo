/**
 * dsh-dingo 系统级通知（host 侧）。
 *
 * 平台后端：
 * - macOS：osascript `display notification`（系统内置，零依赖）。
 *   注意：新版 macOS（26.x）已移除 terminal-notifier 依赖的 NSUserNotification
 *   API（实测 `terminal-notifier` 发送被系统丢弃、`-list` 为空），且 osascript
 *   通知**没有点击回调**——macOS 系统通知仅作"切走应用时的提醒"，直达走
 *   浏览器内卡片（sessions.open）；
 * - Windows：`scripts/notify.ps1` + `scripts/toast-activate.ps1`（PowerShell
 *   toast，抄自 dsh-ding 改造），点击通知直达会话（深链 `?dingOpen=`）；
 * - 其他平台：no-op + logger（提示不支持）。
 *
 * 深链 URL：`<webuiBaseUrl>/?dingOpen=<base64url(sessionId)>`（dsh-ding 同款格式；
 * base64url 只含安全字符，Windows toast launch / 命令行 / URL 均无转义问题）。
 * client 解析 `dingOpen` 后 sessions.open 直达。
 *
 * @module dsh-dingo/sysnotify
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 系统通知参数。 */
export interface SystemNotifyOptions {
  /** 通知标题（缺省「DSH 提醒」/「DSH Ding」）。 */
  title?: string;
  /** 通知正文（工作区/会话摘要）。 */
  message: string;
  /** 目标会话 id：Windows 点击通知直达用；macOS 无点击回调（仅随通知内容提示）。 */
  sessionId?: string;
  /** DSH WebUI 基地址（如 http://127.0.0.1:3080）。 */
  webuiBaseUrl: string;
  /** 日志（debug 用）。 */
  logger?: (message: string) => void;
}

/** 生成会话深链 URL：`<base>/?dingOpen=<base64url(sessionId)>`（dsh-ding 同款格式；
 * base64url 只含安全字符，Windows toast launch / 命令行 / URL 均无转义问题）。
 * client 解析 `dingOpen` 后 sessions.open 直达。 */
export function deepLinkUrl(baseUrl: string, sessionId: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('dingOpen', toBase64Url(sessionId));
  return url.toString();
}

/** UTF-8 → base64url（无填充，安全字符集）。 */
export function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** 发一条系统级通知（平台后端；不支持平台 no-op + log）。 */
export function sendSystemNotification(options: SystemNotifyOptions): void {
  const log = options.logger ?? (() => {});
  try {
    if (process.platform === 'darwin') {
      sendMacNotification(options);
    } else if (process.platform === 'win32') {
      sendWindowsNotification(options);
    } else {
      log(`[dingo-sysnotify] 平台 ${process.platform} 暂不支持系统通知，已跳过（浏览器内卡片仍可用）`);
    }
  } catch (error) {
    log(`[dingo-sysnotify] 发送失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** macOS：osascript `display notification`（系统内置；无点击回调，仅提醒）。 */
function sendMacNotification(options: SystemNotifyOptions): void {
  const log = options.logger ?? (() => {});
  const title = options.title ?? 'DSH 提醒';
  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `display notification "${esc(options.message)}" with title "${esc(title)}" sound name "Glass"`;
  const child = spawn('/usr/bin/osascript', ['-e', script], { stdio: 'ignore' });
  child.on('error', (error: NodeJS.ErrnoException) => {
    log(`[dingo-sysnotify] osascript 启动失败: ${error.message}`);
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) log(`[dingo-sysnotify] osascript 退出码 ${code}`);
  });
}

/** Windows：PowerShell toast（scripts/notify.ps1，点击打开深链 URL）。 */
function sendWindowsNotification(options: SystemNotifyOptions): void {
  const log = options.logger ?? (() => {});
  const script = fileURLToPath(new URL('../scripts/notify.ps1', import.meta.url));
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Title', options.title ?? 'DSH 提醒',
    '-Text', options.message,
  ];
  if (options.sessionId !== undefined && options.sessionId !== '') {
    args.push('-SessionId', options.sessionId, '-BaseUrl', options.webuiBaseUrl);
  }
  const child = spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore' });
  child.on('error', (error: NodeJS.ErrnoException) => {
    log(`[dingo-sysnotify] powershell 启动失败: ${error.message}`);
  });
}
