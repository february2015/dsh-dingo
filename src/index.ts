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
import { safeService } from './feedback.ts';
import { sessionTitleFromCache } from './session-titles.ts';

export const name = 'dsh-dingo';

/**
 * 插件初始化前必须可用的宿主服务。
 *
 * 0.2 起宿主不再有 `apiProxy`（会话/工作区改由 `sessionController` /
 * `workspaceController` 提供），所以这里只声明两件确定存在的；其余一律
 * `ctx.get()` 软取，缺了就走降级路径（cwd basename 兜底、不做跨工作区补卡）。
 */
export const inject = ['connection', 'tools'] as const;

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
  enabled: z.boolean().default(true), // /dingo on|off 开关（默认开；运行时内存态，重启回默认）
  // 系统级通知（macOS 通知中心 / Windows toast）：其他对话的需回答/完成/失败
  // 额外发一条系统通知，点击直达对应会话（浏览器内卡片提醒不受影响）
  systemNotify: z.boolean().default(true),
  // 系统通知点击直达用的 DSH WebUI 基地址（空 = 自动取宿主自述地址）
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
  // 深链基地址：显式配置优先，否则在真正发通知时问宿主（地址在 apply 之后才就绪，
  // 且 0.2 的 Web GUI 是随机端口，写死 3080 会让 Windows toast 打开死链）。
  const webuiBaseUrl = (): string => resolveWebuiBaseUrl(ctx, cfg.systemNotifyBaseUrl);
  const installOptions: FeedbackInstallOptions = {
    config: cfg.feedback as unknown as FeedbackInstallOptions['config'],
    audio,
    logger: (message) => logger.info(message),
    resolveCachedSessionTitle: (sessionId) => sessionTitleFromCache(sessionId),
    resolveTaskswarm: () => {
      const svc = ctx.get('taskswarm') as { getSnapshot(): { batches: Array<{ ownerSessionId?: string; phase: string; lanes?: Array<{ phase: string; wave?: number }> }> } } | undefined
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
        webuiBaseUrl: webuiBaseUrl(),
        logger: (message) => logger.info(message),
      });
    },
  };
  let feedback: FeedbackEngine = installFeedback(ctx, installOptions);

  // ── 跨工作区补卡（DSH 0.2+） ────────────────────────────────────────
  // 宿主事件（session/event、agent/status）本来就是进程级全量，所以别的工作区
  // 会话的后续变化照样能收到；这一层补的是**事件流覆盖不到的那部分**：
  // 插件加载/DSH 重启前就已开始或刚结束、不会再产生新事件的会话。
  // 定期拉一次 sessionController.list()（全量、活跃度序、与 GUI 侧栏同源）。
  // 服务缺席（旧宿主）→ 静默跳过，只剩事件驱动。
  type SessionControllerLike = {
    list?(
      request: unknown,
      signal?: unknown,
    ): Promise<{ items?: readonly import('./feedback.ts').ExternalSessionSummary[] }>;
  };
  const sessionController = (ctx as unknown as { get?: (name: string) => unknown }).get?.('sessionController') as
    | SessionControllerLike
    | undefined;
  if (sessionController?.list) {
    let stopped = false;
    let reported = false;
    let failures = 0;
    const syncCrossProject = async (): Promise<void> => {
      let result: { items?: readonly import('./feedback.ts').ExternalSessionSummary[] } | undefined;
      try {
        // 这个 Remote 方法的真实签名是 list(request, signal)；部分小版本容忍单参，
        // 先带 signal 调，抛了再退回单参。
        result = await sessionController.list!({}, new AbortController().signal);
      } catch (withSignal) {
        try {
          result = await sessionController.list!({});
        } catch (withoutSignal) {
          failures += 1;
          if (!reported) {
            reported = true;
            logger.warn(
              '[dingo] sessionController.list 失败：' +
                String(withSignal) + ' / ' + String(withoutSignal),
            );
          }
          return;
        }
      }
      if (stopped) return;
      const raw = (result?.items ?? []) as ReadonlyArray<
        import('./feedback.ts').ExternalSessionSummary & {
          projections?: { values?: Record<string, unknown> };
        }
      >;
      // 标题两个来源：list 的 'title' 投影（首选，不碰磁盘）→ 投影缓存（兜底）。
      const items = raw.map((item) => {
        const projected = item?.projections?.values?.title;
        const projectedTitle = typeof projected === 'string' && projected !== '' ? projected : undefined;
        const cached = projectedTitle ?? item.sessionTitle ?? sessionTitleFromCache(item.sessionId);
        return { ...item, projectedTitle, sessionTitle: cached };
      });
      feedback.seedExternalSessions(items);
    };
    void syncCrossProject();
    const timer = setInterval(() => void syncCrossProject(), 5000);
    ctx.effect(() => () => {
      stopped = true;
      clearInterval(timer);
    }, 'dsh-dingo: cross-project session inventory');
  } else {
    logger.info('[dingo] sessionController.list 缺席（旧宿主）：跳过跨工作区补卡，仅事件驱动');
  }

  // ── `/dingo` RPC 通道 + 斜杠命令 ──
  // 当前对话提醒（当/当当）由 feedback 引擎的 turn/end 处理（own 项只播提示音、
  // 不显示卡片）；这里只把"当前查看的会话"上报给引擎（own 判定用）。
  // `/dingo` RPC 通道：本版 DSH 的 `connection.rpc.handle` 不可用（见 rpc-route.ts 头注），
  // 改用插件自注册的 webServer 前缀路由，客户端 `connection.rpc.call` 不用改。
  installDingoRpc(ctx, {
    feedback,
    setCurrentSessionId: (id: string | undefined) => {
      feedback.setActiveSession(id);
    },
    setWebVisible: (visible: boolean) => {
      webVisible = visible;
    },
    debugInventory: async () => {
      const controller = (ctx as unknown as { get?: (name: string) => unknown }).get?.('sessionController') as
        | { list?(request: unknown, signal?: unknown): Promise<{ items?: readonly Record<string, unknown>[] }> }
        | undefined;
      if (!controller?.list) return { controller: false };
      try {
        const res = await controller.list({}, new AbortController().signal);
        const items = res?.items ?? [];
        const first = items[0] ?? {};
        const titled = items.filter((item) => {
          const values = (item as { projections?: { values?: Record<string, unknown> } }).projections?.values;
          return typeof values?.title === 'string' && values.title !== '';
        }).length;
        return {
          controller: true,
          count: items.length,
          titled,
          firstKeys: Object.keys(first),
          firstProjectionKeys: Object.keys(((first as { projections?: { values?: Record<string, unknown> } }).projections?.values) ?? {}),
          firstTitle: ((first as { projections?: { values?: Record<string, unknown> } }).projections?.values?.title) ?? null,
        };
      } catch (error) {
        return { controller: true, error: String(error) };
      }
    },
  });
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

/**
 * 系统通知点击直达用的 WebUI 基地址。
 *
 * 优先级：显式配置 → `webApp.getAdvertisedUrl()`（宿主自述、可能自带访问票据）
 * → `webServer.getOrigin()`（本进程监听的 origin）→ 旧默认 3080。
 * 必须在真正发通知时现取：地址在 apply 阶段往往还没就绪，而且 0.2 的端口是随机的。
 * @param ctx - 宿主上下文。
 * @param configured - 用户配置的基地址（空串 = 自动）。
 * @returns 可用于拼深链的基地址。
 */
export function resolveWebuiBaseUrl(ctx: Context, configured: string): string {
  if (configured !== '') return configured;
  try {
    const advertised = safeService<{ getAdvertisedUrl?(): string }>(ctx, 'webApp')?.getAdvertisedUrl?.();
    if (typeof advertised === 'string' && advertised !== '') return advertised;
  } catch {
    // 服务未就绪/不允许访问 → 继续降级
  }
  try {
    const origin = safeService<{ getOrigin?(): string }>(ctx, 'webServer')?.getOrigin?.();
    if (typeof origin === 'string' && origin !== '') return origin;
  } catch {
    // 同上
  }
  return 'http://127.0.0.1:3080';
}
