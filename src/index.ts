/**
 * dsh-dingo — DSH 声音提醒 + 对话直达插件（host half）。
 *
 * 当前对话最终回复：当（有回复）/ 当当（需回答）提示音（crisp 档）；
 * 其他对话最终回复：另一套声音（soft 档"叮"）同样 1 声/2 声区分 + 右上角小卡片
 * （工作区 + 对话标题 + 状态图标），点击卡片直达对应对话。
 * 提醒只在 turn/end（最终回复）或提问（approval/ask_user/questions）时触发，
 * 过程中的中间回复（assistant/message）不打扰。
 *
 * 全部逻辑 = 会话事件 → 判定级别（isQuestionText）→
 * feedback 队列 → client 播放提示音 + 渲染卡片（+ 系统级通知）。
 *
 * @module dsh-dingo
 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-client-connection';
import z from '@deepseek-ai/schemastery';
import { installFeedback, type FeedbackAudio, type FeedbackEngine, type FeedbackInstallOptions, type AnnouncementView } from './feedback.ts';
import { installDingoRpc } from './rpc.ts';
import { registerDingoCommand } from './command.ts';
import { autoNameSession } from './auto-name.ts';
import { installRenameTool } from './rename-tool.ts';
import { sendSystemNotification } from './sysnotify.ts';
import type { ChannelAuthority } from './types.ts';

export const name = 'dsh-dingo';

/** 插件初始化前必须可用的宿主服务。 */
export const inject = ['connection', 'apiProxy', 'tools'] as const;

/** 设置命名空间（settings UI / profile patch 可覆盖）。 */
const NS = 'dingo';

/**
 * 插件配置 schema。所有字段带默认值；cordis 在 apply 前校验并补全。
 */
export const Config = z.object({
  feedback: z.object({
    enabled: z.boolean().default(true),
    dnd: z.boolean().default(false),
    confirmNeverSilent: z.boolean().default(true),
    dedupeWindowMs: z.number().default(10000),
    // 当前对话自身事件默认不由插播队列处理（当前对话回复走"当/当当"提示音，
    // 由 apply 内的 current-reply 订阅直接入队 own 提醒）
    announceOwnSessions: z.boolean().default(false),
    // 静音时段（"HH:mm"；空串 = 无）→ 任务类只入队不发声，结束后补播
    quietHours: z.object({ start: z.string().default(''), end: z.string().default('') }).default({ start: '', end: '' }),
    // 提示音档位：crisp（当前对话"当"）/ soft（其他对话"叮"）
    toneStyle: z.union(['soft', 'crisp']).default('soft'),
  }),
  enabled: z.boolean().default(true), // /dingo on|off 开关（默认开；settings 持久化）
  channelAuthority: z.union(['loopback', 'trusted-host']).default('loopback'),
  // 系统级通知（macOS 通知中心 / Windows toast）：其他对话的需回答/完成/失败
  // 额外发一条系统通知，点击直达对应会话（浏览器内卡片提醒不受影响）
  systemNotify: z.boolean().default(true),
  // 系统通知点击直达用的 DSH WebUI 基地址（空 = http://127.0.0.1:3080）
  systemNotifyBaseUrl: z.string().default(''),
});

/** 挂载插件：反馈引擎、当前对话提醒订阅、/dingo RPC、斜杠命令。 */
export function apply(ctx: Context, config: unknown): void {
  const cfg = config as {
    enabled: boolean;
    feedback: {
      enabled: boolean;
      dnd: boolean;
      confirmNeverSilent: boolean;
      dedupeWindowMs: number;
      announceOwnSessions: boolean;
      quietHours: { start: string; end: string };
      toneStyle: 'soft' | 'crisp';
    };
    channelAuthority: string;
    systemNotify: boolean;
    systemNotifyBaseUrl: string;
  };
  const logger = ctx.logger(name);
  const enabled = { value: cfg.enabled };

  // ── 极简播报音频端口：不发声（提醒只播提示音，由 client 播放） ─────
  // state 恒非 listening（无"正在说话"概念）→ 插播流程正常驱动；
  // speak 为 no-op（不播语音文本）；playTone 由 client 侧 FeedbackCard 播放。
  const audio: FeedbackAudio = {
    state: () => 'idle',
    pause: () => {},
    resume: () => {},
    stop: () => {},
    speak: () => {},
    playTone: (tone) => logger.info(`[dingo] tone: ${tone}（client 播放）`),
  };

  // ── 反馈引擎（事件源 → 队列 → 提示音/卡片） ────────────────────────
  // 系统通知：DSH 不在前台（webVisible=false）时，任何对话的需回答/完成/失败
  // 入队都发一条系统级通知（含当前对话——你切走了，浏览器内叮当音可能听不到）；
  // DSH Web UI 前台可见时不发（浏览器内提醒已够）。可见性由客户端经
  // /dingo.set-visibility 上报，未上报（Web 未开）视为不可见 → 发系统通知。
  let webVisible = false;
  const webuiBaseUrl = cfg.systemNotifyBaseUrl || 'http://127.0.0.1:3080';
  const installOptions: FeedbackInstallOptions = {
    config: cfg.feedback as unknown as FeedbackInstallOptions['config'],
    audio,
    logger: (message) => logger.info(message),
    resolveTaskswarm: () => {
      const svc = ctx.get('taskswarm') as { getSnapshot(): { batches: Array<{ ownerSessionId?: string; phase: string }> } } | undefined
      return svc?.getSnapshot().batches ?? []
    },
    onEnqueue: (item: AnnouncementView) => {
      if (!cfg.systemNotify) return;
      if (item.category === 'normal') return;
      if (item.sessionId === undefined || item.sessionId === '') return;
      if (webVisible) return; // Web UI 在前台 → 浏览器内提醒已够
      const label = item.workspaceTitle ?? '对话';
      const text = item.category === 'need-confirm'
        ? `${label}需回答`
        : item.category === 'task-error'
          ? `${label}任务失败`
          : `${label}有回复`;
      sendSystemNotification({
        title: 'DSH 提醒',
        message: text,
        sessionId: item.sessionId,
        webuiBaseUrl,
        logger: (message) => logger.info(message),
      });
    },
  };
  let feedback: FeedbackEngine = installFeedback(ctx, installOptions);

  // ── `/dingo` RPC 通道 + 斜杠命令 ──
  // 当前对话提醒（当/当当）由 feedback 引擎的 turn/end 处理（own 项只播提示音、
  // 不显示卡片）；这里只把"当前查看的会话"上报给引擎（own 判定用）。
  installDingoRpc(ctx, {
    feedback,
    setCurrentSessionId: (id: string | undefined) => {
      feedback.setActiveSession(id);
    },
    setWebVisible: (visible: boolean) => {
      webVisible = visible;
    },
  }, cfg.channelAuthority as ChannelAuthority);

  // 对话内自然语言重命名：主 LLM 在当前上下文生成标题后调用本工具写入
  installRenameTool(ctx);

  registerDingoCommand(ctx, {
    runtime: {
      enabled: () => enabled.value,
      setEnabled: (value: boolean) => {
        enabled.value = value;
        // 联动反馈引擎总开关（引擎实时读 config.enabled）
        (cfg.feedback as { enabled: boolean }).enabled = value;
        return enabled.value;
      },
      feedback: () => feedback.snapshot(),
      setDnd: (value: boolean) => feedback.setDnd(value),
      dnd: () => feedback.snapshot().dnd,
    },
    autoName: (sessionId) => autoNameSession(ctx, sessionId),
  });
}
