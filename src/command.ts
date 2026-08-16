/**
 * `/dingo` 斜杠命令（on|off|status|dnd|rename）。
 *
 * - `on` / `off`：切换提醒功能运行时开关；
 * - `status`：报告开关、DND、插播队列（当前/其他对话提醒计数）；
 * - `dnd on|off`：免打扰切换（任务完成类静音、确认类默认仍播）；
 *   `dnd`（无参）= 查询；
 * - `rename` / `auto-name`：自动命名当前对话（与按钮同一套 host 逻辑）。
 *
 * @module dsh-dingo/command
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands';
import type { FeedbackEngine } from './feedback.ts';

/** `/dingo` 命令依赖。 */
export interface DingoCommandDeps {
  readonly runtime: {
    enabled(): boolean;
    setEnabled(value: boolean): boolean;
    dnd(): boolean;
    setDnd(value: boolean): boolean;
    feedback(): ReturnType<FeedbackEngine['snapshot']>;
  };
  /** 自动命名当前会话（host 侧同一套逻辑）。 */
  readonly autoName?: (sessionId: string) => Promise<{ ok: boolean; title?: string; error?: string }>;
}

/** 注册 `/dingo` 命令（headless 无命令注册表时静默跳过）。 */
export function registerDingoCommand(ctx: Context, deps: DingoCommandDeps): void {
  const commands = ctx.get('commands');
  if (commands === undefined) return; // headless deployments without the command registry
  commands.register({
    name: 'dingo',
    description: 'dsh-dingo: on|off|status|dnd|rename',
    input: { hint: 'on | off | status | dnd [on|off] | rename' },
    handler: (invocation) => dingoCommand(invocation, deps),
  });
}

async function dingoCommand(invocation: CommandInvocation, deps: DingoCommandDeps): Promise<CommandResult> {
  const raw = invocation.rawInput.trim();
  if (raw === 'on' || raw === 'off') {
    const now = deps.runtime.setEnabled(raw === 'on');
    const tip = now ? '提醒已开启：当前对话当/当当（crisp 档），其他对话叮/叮叮（soft 档）+ 卡片。' : '提醒已关闭。';
    return { kind: 'success', text: `dsh-dingo is now ${now ? 'ON' : 'off'}. ${tip}` };
  }
  if (raw === 'status' || raw === '') {
    return { kind: 'success', text: statusText(deps) };
  }
  if (raw === 'dnd' || raw === 'dnd on' || raw === 'dnd off') {
    if (raw !== 'dnd') deps.runtime.setDnd(raw === 'dnd on');
    const dnd = deps.runtime.dnd();
    const tip = dnd ? '免打扰已开启：任务完成类提醒静音（需回答仍提醒）。' : '免打扰已关闭。';
    return { kind: 'success', text: `dsh-dingo dnd: ${dnd ? 'on' : 'off'}. ${tip}` };
  }
  if (raw === 'rename' || raw === 'auto-name') {
    if (!deps.autoName) {
      return { kind: 'error', text: 'dsh-dingo: auto-name 不可用（缺少 autoName 依赖）' };
    }
    const sessionId = String(invocation.agent.session.id);
    const result = await deps.autoName(sessionId);
    if (!result.ok) {
      return { kind: 'error', text: `dsh-dingo: 自动命名失败 — ${result.error ?? '未知错误'}` };
    }
    return { kind: 'success', text: `已重命名为：${result.title}` };
  }
  return { kind: 'error', text: 'dsh-dingo: unknown argument — use on | off | status | dnd [on|off] | rename.' };
}

/** 组装 `/dingo status` 文案。 */
function statusText(deps: DingoCommandDeps): string {
  const feedback = deps.runtime.feedback();
  const pending = feedback.queue.filter((item) => item.state === 'pending' || item.state === 'deferred').length;
  const speaking = feedback.queue.find((item) => item.state === 'speaking');
  return [
    `dsh-dingo: ${deps.runtime.enabled() ? 'on' : 'off'} · dnd: ${deps.runtime.dnd() ? 'on' : 'off'}`,
    `feedback: enabled · queue ${pending} pending · ${speaking ? `speaking「${speaking.text}」` : 'idle'}`,
    `  quietNow: ${feedback.quietNow ? 'yes' : 'no'} · dedupeWindow: ${feedback.dedupeWindowMs}ms`,
    'Use /dingo on|off to enable/disable reminders.',
  ].join('\n');
}
