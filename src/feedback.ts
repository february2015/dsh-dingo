/**
 * FR-6 全局插播反馈（跨会话通知语音）—— host 决策与编排层。
 *
 * 职责：五事件源订阅与分类 → 提示音 + 播报模板 → 优先级插播队列 →
 * 暂停/恢复当前正文 → 30s 去重 → DND 免打扰（确认类默认永不静音）。
 *
 * ## 事件源（FR-6.1，见 {@link installFeedback} 的接线）
 *
 * | 事件 | 来源 | 分类 | 提示音 |
 * |---|---|---|---|
 * | 别会话 `turn/end`(completed) + `assistant/message` | `session/event` | task-done | ding |
 * | jobs 域 settled（completed / failed） | `ctx.jobs.onJobDone` | task-done / task-error | ding / dong |
 * | `approval/asked` | `session/event` | need-confirm | ding-ding |
 * | questions 域 `ask()` | 包装 `ctx.userQuestions.ask` | need-confirm | ding-ding |
 *
 * ## 队列（FR-6.3）
 *
 * - 优先级：need-confirm(3) > task-done/task-error(2) > normal(1)；同优先级 FIFO；
 * - 播报当前正文（speaking/broadcasting）时 → `audio.pause()` → 提示音 +
 *   `audio.speak(插播文本)` → 客户端上报播完（`completeSpeech`）→
 *   `audio.resume()` 恢复剩余正文；思考/工具阶段（thinking/tooling）直接插播；
 * - 插播期间 barge-in（T-6 interrupt 调 {@link FeedbackEngine.interruptCurrent}）
 *   → `audio.stop()`、该项放回队列头（保留可重播，1.5s 冷却防循环）；
 * - 多条事件逐条播（tick 串行循环）。
 *
 * ## 去重与 DND（FR-6.3 / FR-6.4）
 *
 * - 去重：同会话同内容事件 10s 窗口去重（窗口可配 `dedupeWindowMs`；
 *   内容指纹 = 摘要文本，不同内容仍各自提示）；
 * - DND：`/voice dnd on` → 任务类（task-done/task-error/normal）入队但**不发声**
 *   （deferred，关闭后补播）；确认类（need-confirm）默认仍播（`confirmNeverSilent`）；
 * - 静音时段（可配 `quietHours` "HH:mm"）＝自动 DND：任务类只入队不发声，
 *   时段结束后补播。
 *
 * ## 契约（与 T-5/T-6 的接口约定）
 *
 * - 播报控制：`FeedbackAudio`（dsh-dingo 极简实现，见 src/index.ts），
 *   引擎用 `completeSpeech()` 显式接收「播完」信号（生产=客户端经
 *   `/dingo.feedback {action:'spoken'}` 上报；测试=显式调用）；
 * - 提示音：`playTone` 由宿主接 client（FeedbackCard 轮询 speaking 项播放）；
 * - barge-in 停止钩子：客户端 `/dingo.feedback {action:'interrupt'}`。
 *
 * @module dsh-localvoice/feedback
 */
import type { Context } from '@deepseek-ai/cordis';
import type { VoiceState } from './types.ts';
import { isQuestionText } from './question.ts';

// ─────────────────────────── 类型与常量 ───────────────────────────

/** 提示音标识（FR-6.2：ding=一声柔和 / ding-ding=两声短促 / dong=低音一声）。 */
export type ToneId = 'ding' | 'ding-ding' | 'dong' | 'none';

/** 插播分类（FR-6.2 提示音区分的基础）。 */
export type FeedbackCategory = 'need-confirm' | 'task-done' | 'task-error' | 'normal';

/** 插播优先级：need-confirm > task-done（含 task-error）> normal（FR-6.3）。 */
export const FEEDBACK_PRIORITY: Readonly<Record<FeedbackCategory, number>> = {
  'need-confirm': 3,
  'task-done': 2,
  'task-error': 2,
  normal: 1,
};

/** 分类 → 提示音（FR-6.2）。 */
export const FEEDBACK_TONE: Readonly<Record<FeedbackCategory, ToneId>> = {
  'need-confirm': 'ding-ding',
  'task-done': 'ding',
  'task-error': 'dong',
  normal: 'none',
};

/** 一条插播项在队列中的生命周期。 */
export type AnnouncementState = 'pending' | 'deferred' | 'speaking' | 'spoken';

/** 队列中的一条插播项（决策层内部表示；对外暴露用 {@link AnnouncementView}）。 */
export interface Announcement {
  readonly id: string;
  readonly category: FeedbackCategory;
  /** 派生：FEEDBACK_PRIORITY[category]。 */
  readonly priority: number;
  /** 派生：FEEDBACK_TONE[category]。 */
  readonly tone: ToneId;
  /** 最终播报文本（按模板拼好；去重合并时更新）。 */
  text: string;
  /** 去重键：`<sessionId>:<category>`（同会话同类型 30s 窗口）。 */
  readonly dedupeKey: string;
  /** 事件所属会话 id（UI 卡片点击跳转用；可能缺省）。 */
  readonly sessionId?: string;
  /** 是否当前对话（客户端上报的正在查看会话）：只播提示音、不显示卡片。 */
  readonly own?: boolean;
  /** 工作区标题（workspace.title，可能缺省）。 */
  readonly workspaceTitle?: string;
  /** 会话标题（session.title，可能缺省）。 */
  readonly sessionTitle?: string;
  /** 任务名/工具名（task-error 模板用；缺省取 sessionTitle）。 */
  readonly name?: string;
  /** 事件来源标记（调试/UI：'session/turn-end' | 'jobs' | 'approval' | 'questions'）。 */
  readonly source: string;
  /** 入队时间（epoch ms，可注入时钟）。 */
  readonly createdAt: number;
  /** barge-in 后最早可重播时间（epoch ms，防死循环）。 */
  replayAt: number;
  /** barge-in 打断次数（超限丢弃）。 */
  replayCount: number;
  /** 是否可重播（FR-6.3：插播 barge-in 后队列保留）。 */
  readonly replayable: boolean;
  state: AnnouncementState;
}

/** 对外（RPC / client 卡片）的插播项视图。 */
export interface AnnouncementView {
  readonly id: string;
  readonly category: FeedbackCategory;
  readonly priority: number;
  readonly tone: ToneId;
  readonly text: string;
  readonly state: AnnouncementState;
  /** 事件所属会话 id（UI 卡片点击跳转用；可能缺省）。 */
  readonly sessionId?: string;
  /** 是否当前对话：只播提示音、不显示卡片。 */
  readonly own?: boolean;
  readonly workspaceTitle?: string;
  readonly sessionTitle?: string;
  readonly name?: string;
  readonly source: string;
  readonly createdAt: number;
  readonly replayable: boolean;
}

/** 反馈引擎快照（`/voice.status` 与 `/voice.feedback` 共用）。 */
export interface FeedbackSnapshot {
  readonly enabled: boolean;
  readonly dnd: boolean;
  readonly confirmNeverSilent: boolean;
  readonly dedupeWindowMs: number;
  /** 当前是否处于静音时段（quietHours）。 */
  readonly quietNow: boolean;
  /** 当前「正在听」的会话 id（客户端上报；缺省 = 未知）。 */
  readonly activeSessionId?: string;
  /** 队列中的插播项（pending + deferred + speaking，按优先级序）。 */
  readonly queue: readonly AnnouncementView[];
  /** 最近已播（cap 8）。 */
  readonly history: readonly AnnouncementView[];
  readonly lastSpoken?: AnnouncementView;
  /** T-8 音效打磨：提示音档位（soft 柔和默认 / crisp 清脆）。 */
  readonly toneStyle?: 'soft' | 'crisp';
}

/** 反馈配置（由插件 Config.feedback 派生，见 src/types.ts）。 */
export interface FeedbackConfig {
  /** 总开关（false = 事件只忽略，不产生任何插播）。 */
  readonly enabled: boolean;
  /** DND 免打扰（`/voice dnd on|off`，live 可变）。 */
  dnd: boolean;
  /** 确认类默认永不静音（FR-6.4）。 */
  readonly confirmNeverSilent: boolean;
  /** 去重窗口（ms，默认 10000：同会话同内容 10s 内不重复提示）。 */
  readonly dedupeWindowMs: number;
  /** 同会话自身事件是否也插播（FR-6.3，默认 false = 不插播）。 */
  readonly announceOwnSessions?: boolean;
  /** 静音时段（"HH:mm" 24h；空串 = 无；start>end 视为跨夜）。 */
  readonly quietHours?: { readonly start: string; readonly end: string };
  /** T-8 音效打磨：提示音档位（soft 柔和默认 / crisp 清脆）。 */
  readonly toneStyle?: 'soft' | 'crisp';
}

/**
 * 播报音频端口（dsh-dingo 极简实现：speak 不发声，仅提示音/完成流程）。
 *
 * 引擎用 `completeSpeech()`/`interruptCurrent()` 显式接收完成/打断信号，
 * 不依赖 speak 的返回值（T-5 状态机 speak 即 fire-and-forget）。
 */
export interface FeedbackAudio {
  /** 当前状态机状态（listening = 用户正在说话，不插播）。 */
  state(): VoiceState;
  /** 暂停当前正文播报（保留播放位置；FR-6.3 插播前）。 */
  pause(): void;
  /** 恢复当前正文播报（插播完成后）。 */
  resume(): void;
  /** 停止一切播报（barge-in / 控制命令）。 */
  stop(): void;
  /** 播插播文本（经 TTS 通道；与正文同通道）。 */
  speak(text: string): void;
  /** 播放提示音（内置 wav，**不占用 TTS 合成通道**）。 */
  playTone(tone: ToneId): void;
}

/** 反馈引擎依赖（index.ts 装配；测试注入 fake）。 */
export interface FeedbackDeps {
  /** 播报音频端口（dsh-dingo 极简实现；测试 = fake）。 */
  readonly audio: FeedbackAudio;
  /** 反馈配置（live 读取；dnd 由 /voice dnd 切换）。 */
  readonly config: FeedbackConfig;
  /** 会话 → 工作区标题解析（缺省经 ctx.apiProxy.workspace.list()，懒缓存）。 */
  readonly resolveWorkspace?: (sessionId: string, cwd?: string) => Promise<string | undefined>;
  /**
   * 会话 → 会话标题解析（缺省经 ctx.apiProxy.sessions.list() 的
   * `session/title` 投影，懒缓存；不可用 → undefined，模板回落「会话」）。
   */
  readonly resolveSessionTitle?: (sessionId: string) => Promise<string | undefined>;
  /** 日志（缺省静默）。 */
  readonly logger?: (message: string) => void;
  /** 可注入时钟（测试用）。 */
  readonly now?: () => number;
  /** 测试辅助：speak 后自动完成（跳过显式 completeSpeech）。 */
  readonly autoCompleteSpeech?: boolean;
}

/** barge-in 打断后重播冷却（ms）。 */
const REPLAY_BACKOFF_MS = 1500;
/** barge-in 打断重播上限（超限丢弃，防死循环）。 */
const MAX_REPLAY_COUNT = 2;
/** 最近已播历史上限。 */
const HISTORY_CAP = 8;
// ─────────────────────────── 播报模板 ───────────────────────────

/**
 * 拼一条插播文本（FR-6.2 模板）。
 *
 * 模板：
 *   - `【叮】X工作区有回复`   —— 对话完成回复（不读正文/摘要，只提醒哪个工作区）
 *   - `【叮叮】X工作区需回答` —— 需要用户交互/确认（同样只提醒工作区，点卡片去看）
 *   - `【咚】X工作区任务失败` —— 任务失败（同样不带摘要/详情，点卡片去看）
 * task-done / need-confirm / task-error 均不带摘要（用户反馈太吵）。
 */
export function formatAnnouncement(
  category: FeedbackCategory,
  parts: { workspaceTitle?: string; sessionTitle?: string; name?: string; summary: string },
): string {
  const ws = parts.workspaceTitle ?? '';
  const session = parts.sessionTitle ? `「${parts.sessionTitle}」` : '「会话」';
  switch (category) {
    case 'need-confirm':
      // 需回答提醒：只说哪个工作区需要回答，不读问题详情（点卡片去看）
      return ws === '' ? '【叮叮】需回答' : `【叮叮】${ws}需回答`;
    case 'task-done':
      // 回复提醒：只说哪个工作区有回复，不读正文/摘要
      return ws === '' ? '【叮】有回复' : `【叮】${ws}有回复`;
    case 'task-error':
      // 失败提醒：只说哪个工作区任务失败，不带摘要/任务名
      return ws === '' ? '【咚】任务失败' : `【咚】${ws}任务失败`;
    default:
      return parts.summary;
  }
}

/** 一句话摘要兜底文本（LLM 不可用/空输入）。 */
const NO_SUMMARY = '（无摘要）';

// ─────────────────────────── 引擎 ───────────────────────────

/**
 * 全局插播反馈引擎（host 决策 + 编排层）。
 *
 * 线程模型：事件处理器（session/event、onJobDone、questions wrap）只做
 * 「分类 → 去重 → 入队」；真正的播报由 {@link tick} 串行循环驱动（一次一条，
 * 等 `completeSpeech()` 后再播下一条），避免并发 speak 互相踩踏。所有公开
 * 方法可安全地从任意事件上下文调用。
 */
export class FeedbackEngine {
  /** 队列：按优先级降序、同优先级 FIFO（pending + deferred + speaking）。 */
  private queue: Announcement[] = [];
  /** 去重表：dedupeKey → 最近事件时间（ms）。 */
  private readonly recent = new Map<string, number>();
  /** 最近已播历史（UI 用）。 */
  private readonly history: AnnouncementView[] = [];
  /** 正在播报的项。 */
  private active: Announcement | null = null;
  /** tick 是否正在执行（串行闸）。 */
  private busy = false;
  /** 为插播暂停了当前正文（播完需恢复）。 */
  private pausedMain = false;
  /** 当前插播播完等待器（completeSpeech/interruptCurrent 收尾）。 */
  private speechWaiter: { itemId: string; resolve: (ok: boolean) => void } | null = null;
  /** barge-in 代际令牌（每轮 tick 捕获，感知打断）。 */
  private interruptSeq = 0;
  /** 会话标题缓存（session/title 事件）。 */
  private readonly sessionTitles = new Map<string, string>();
  /** 会话最近 assistant 文本（turn/end 时取摘要源）。 */
  private readonly assistantText = new Map<string, string>();
  /** 工作区标题缓存（sessionId → workspaceTitle）。 */
  private readonly workspaceCache = new Map<string, string>();
  /** 客户端上报的「正在听」会话。 */
  private activeSessionId: string | undefined;
  /** 冷却到期/去重窗口到期的重查定时器。 */
  private nextTimer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;

  constructor(private readonly deps: FeedbackDeps) {}

  /** 释放定时器（插件卸载）。 */
  dispose(): void {
    if (this.nextTimer !== undefined) {
      clearTimeout(this.nextTimer);
      this.nextTimer = undefined;
    }
  }

  // ── 只读访问 ──

  /** 当前「正在听」的会话 id（客户端上报；undefined = 未知）。 */
  get currentSession(): string | undefined {
    return this.activeSessionId;
  }

  /** 快照（/voice.status 与 /voice.feedback 共用）。 */
  snapshot(): FeedbackSnapshot {
    const cfg = this.deps.config;
    return {
      enabled: cfg.enabled,
      dnd: cfg.dnd,
      confirmNeverSilent: cfg.confirmNeverSilent,
      dedupeWindowMs: cfg.dedupeWindowMs,
      quietNow: isQuietNow(cfg.quietHours, this.now()),
      activeSessionId: this.activeSessionId,
      queue: this.queue.map((item) => toView(item)),
      history: [...this.history],
      lastSpoken: this.history[0],
      toneStyle: cfg.toneStyle ?? 'soft',
    };
  }

  /** 队列（含 deferred/speaking）按优先级序的视图。 */
  pendingViews(): readonly AnnouncementView[] {
    return this.queue.map((item) => toView(item));
  }

  // ── 事件入口（五事件源） ──

  /**
   * `session/event` 处理器（FR-6.1：turn/end + assistant/message → task-done；
   * approval/asked → need-confirm；session/title 记标题缓存）。
   */
  handleSessionEvent(session: { id: string; header?: { cwd?: string } }, event: SessionEventLike): void {
    if (!this.deps.config.enabled) return;
    const sessionId = String(session.id);
    switch (event.type) {
      case 'session/title': {
        const title = (event as SessionEventLike & { data?: { title?: string } }).data?.title;
        if (title) this.sessionTitles.set(sessionId, title);
        return;
      }
      case 'assistant/message': {
        // 生产形状（dsh-session）：{ type, data: { turn, step, message, usage? } }
        // —— 消息本体在 event.data.message；兼容旧形状 event.message（测试/旧事件）。
        const record = event as SessionEventLike & {
          data?: { message?: { content?: unknown } };
          message?: { content?: unknown };
        };
        const message = record.data?.message ?? record.message;
        const text = extractMessageText(message?.content);
        if (text) this.assistantText.set(sessionId, text);
        return;
      }
      case 'turn/end': {
        const reason = (event as SessionEventLike & { data?: { reason?: { kind?: string } } }).data?.reason;
        if (reason?.kind !== 'completed') return; // aborted/error/max-tokens 不算完成
        if (this.isOwnSession(sessionId)) return; // 当前对话自身事件由"当前对话提醒"处理（叮/叮叮）
        const text = this.assistantText.get(sessionId) ?? '';
        // 其他对话回复：含疑问/请求确认 → "需回答"（叮叮 2 声），否则 "有回复"（叮 1 声）
        if (isQuestionText(text)) {
          void this.announceNeedConfirm(sessionId, text || '有新内容需要你回答', 'session/turn-end');
        } else {
          void this.announceTaskDone(sessionId, session.header?.cwd, text, 'session/turn-end');
        }
        return;
      }
      case 'approval/asked': {
        const data = (event as SessionEventLike & { data?: { toolName?: string; reason?: string } }).data;
        // 需回答类：当前对话也提醒（用户要看对话里的审批请求；broadcast 只处理文本回复）
        const summary = data?.toolName ? `${data.toolName}${data.reason ? `：${data.reason}` : ''}` : (data?.reason ?? '工具调用');
        void this.announceNeedConfirm(sessionId, summary, 'approval');
        return;
      }
      case 'tool/call': {
        // dsh-tool-ask-user / ask_user 工具：向用户提问 → 需回答提醒（当前对话也提醒）
        const tool = String((event as SessionEventLike & { data?: { name?: string } }).data?.name ?? '').toLowerCase();
        if (/ask[_-]?user/.test(tool)) {
          void this.announceNeedConfirm(sessionId, '有新问题需要你回答', 'tool-ask-user');
        }
        return;
      }
      default:
        return;
    }
  }

  /** jobs 域 settled 处理器（FR-6.1：completed → task-done；failed → task-error）。 */
  handleJobSettled(snapshot: JobSnapshotLike): void {
    if (!this.deps.config.enabled) return;
    const sessionId = typeof snapshot.ownerSession === 'string' ? snapshot.ownerSession : undefined;
    if (sessionId !== undefined && this.isOwnSession(sessionId)) return;
    const label = snapshot.label ?? snapshot.detail ?? '后台任务';
    if (snapshot.status === 'completed') {
      void this.announceTaskDone(sessionId, undefined, label, 'jobs');
    } else if (snapshot.status === 'failed') {
      void this.announceTaskError(sessionId, label, snapshot.detail ?? '任务执行失败', 'jobs');
    }
    // killed → 不播
  }

  /** questions 域 ask() 处理器（need-confirm，最高优先级；当前对话也提醒）。 */
  handleQuestionAsked(input: { sessionId?: string; questions: readonly { text?: string; title?: string }[] }): void {
    if (!this.deps.config.enabled) return;
    const sessionId = input.sessionId;
    const first = input.questions[0];
    const summary = first?.text?.trim() || first?.title?.trim() || '有新问题需要你回答';
    void this.announceNeedConfirm(sessionId, summary, 'questions');
  }

  /**
   * 通用入队入口（普通播报/其它事件源；与五事件源共用分类/去重/DND 逻辑）。
   * `normal` 为最低优先级（FR-6.3 普通播报 tier）。
   */
  announce(category: FeedbackCategory, options: {
    sessionId?: string;
    workspaceTitle?: string;
    sessionTitle?: string;
    summary: string;
    source?: string;
  }): void {
    if (!this.deps.config.enabled) return;
    this.enqueue({
      category,
      workspaceTitle: options.workspaceTitle,
      sessionTitle: options.sessionTitle,
      summary: options.summary,
      source: options.source ?? 'manual',
      sessionId: options.sessionId,
    });
  }

  /**
   * 重查队列并尝试播报（供 RPC status / 定时器 / 测试在 DND 解除、冷却到期后
   * 主动驱动；生产由 {@link scheduleRecheck} 定时器兜底）。
   */
  recheck(): void {
    this.scheduleRecheck();
    void this.tick();
  }

  // ── 状态入口（RPC / 命令 / 客户端） ──

  /** 客户端上报「正在听的会话」（别会话判定用）。 */
  setActiveSession(sessionId: string | undefined): void {
    this.activeSessionId = sessionId === '' ? undefined : sessionId;
  }

  /** `/voice dnd on|off`：切换免打扰（任务类静音、确认类仍播）。 */
  setDnd(value: boolean): boolean {
    this.deps.config.dnd = value;
    if (!value) {
      this.requeueDeferred(); // 关闭 DND → 补播被静音的项
      void this.tick();
    }
    return this.deps.config.dnd;
  }

  /** 丢弃一条队列项（UI 关闭卡片）。 */
  dismiss(id: string): boolean {
    const index = this.queue.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    return true;
  }

  /** 重播一条已播项（UI）。 */
  replay(id: string): boolean {
    const base = this.queue.find((item) => item.id === id) ?? this.history.find((item) => item.id === id);
    if (!base) return false;
    this.insertAtTierHead(fromView(base));
    void this.tick();
    return true;
  }

  /**
   * 客户端上报：当前插播已播完（`/voice.feedback {action:'spoken'}`）。
   * 引擎据此恢复正文（若插播前暂停过）并播下一条。
   */
  completeSpeech(itemId?: string): void {
    const waiter = this.speechWaiter;
    if (!waiter) return;
    if (itemId !== undefined && waiter.itemId !== itemId) return; // 迟到的过期上报
    this.speechWaiter = null;
    waiter.resolve(true);
  }

  /**
   * barge-in 停止钩子（T-6 interrupt 调用；也可由客户端 `/voice.feedback
   * {action:'interrupt'}` 触发）：停止当前插播，该项由 tick 放回队列头
   * （保留可重播，冷却后重播）。
   */
  interruptCurrent(): void {
    if (this.active === null && this.speechWaiter === null) return;
    this.interruptSeq += 1;
    this.pausedMain = false; // barge-in 已整体停止播报，放弃恢复义务
    this.deps.audio.stop();
    const waiter = this.speechWaiter;
    this.speechWaiter = null;
    waiter?.resolve(false);
  }

  // ── 内部：分类 → 去重 → 入队 ──

  private async announceTaskDone(sessionId: string | undefined, cwd: string | undefined, replyText: string, source: string): Promise<void> {
    const workspaceTitle = await this.resolveWorkspaceTitle(sessionId, cwd);
    const sessionTitle = sessionId ? await this.resolveSessionTitleCache(sessionId) : undefined;
    this.enqueue({
      category: 'task-done',
      workspaceTitle,
      sessionTitle,
      // 内容指纹：用回复文本区分"不同任务完成"（播报文本不受影响——
      // task-done 只播"有回复"，不读 summary）
      summary: replyText,
      source,
      sessionId,
    });
  }

  private async announceTaskError(sessionId: string | undefined, name: string, detail: string, source: string): Promise<void> {
    const workspaceTitle = sessionId ? await this.resolveWorkspaceTitle(sessionId) : undefined;
    this.enqueue({
      category: 'task-error',
      workspaceTitle,
      sessionTitle: sessionId ? await this.resolveSessionTitleCache(sessionId) : undefined,
      name,
      summary: detail || NO_SUMMARY,
      source,
      sessionId,
    });
  }

  private async announceNeedConfirm(sessionId: string | undefined, summary: string, source: string): Promise<void> {
    // 当前对话的需回答：不带工作区名（用户正看着对话，说"需回答"即可）；
    // 非当前对话才带"XX工作区"（用户不知道是哪个工作区）
    const isCurrent = sessionId !== undefined && this.activeSessionId === sessionId;
    const workspaceTitle = sessionId !== undefined && !isCurrent
      ? await this.resolveWorkspaceTitle(sessionId)
      : undefined;
    this.enqueue({
      category: 'need-confirm',
      workspaceTitle,
      sessionTitle: sessionId ? await this.resolveSessionTitleCache(sessionId) : undefined,
      summary,
      source,
      sessionId,
    });
  }

  /** 入队请求（分类 + 模板 + 去重 + 优先级插入）。 */
  private enqueue(request: {
    category: FeedbackCategory;
    workspaceTitle?: string;
    sessionTitle?: string;
    summary: string;
    name?: string;
    source: string;
    sessionId?: string;
  }): void {
    const now = this.now();
    const key = dedupeKey(request.sessionId, request.category, request.summary);
    // 10s 去重：同会话同内容窗口内 → 吞掉（不重复提示；窗口顺延）。
    // 不同内容（不同摘要）不受影响，各自提示。
    if (this.isDuplicate(key, now)) {
      this.recent.set(key, now); // 滑动窗口：连续轰炸时窗口顺延
      return;
    }
    this.recent.set(key, now);
    this.pruneRecent(now);

    const item: Announcement = {
      id: `ann-${++this.seq}`,
      category: request.category,
      priority: FEEDBACK_PRIORITY[request.category],
      tone: FEEDBACK_TONE[request.category],
      text: '',
      dedupeKey: key,
      sessionId: request.sessionId,
      // 当前对话（客户端上报的正在查看会话）：只播提示音、不显示卡片
      own: request.sessionId !== undefined && request.sessionId === this.activeSessionId,
      workspaceTitle: request.workspaceTitle,
      sessionTitle: request.sessionTitle,
      name: request.name,
      source: request.source,
      createdAt: now,
      replayAt: 0,
      replayCount: 0,
      replayable: request.category !== 'normal',
      state: 'pending',
    };
    item.text = this.renderText(item, request.summary);
    this.insert(item);
    this.scheduleRecheck();
    this.deps.logger?.(`[feedback] enqueue ${request.category} (${request.source}): ${item.text}`);
    void this.tick();
  }

  /** 最早 pending 项冷却到期时重查队列（生产兜底：无新事件也要能补播）。 */
  private scheduleRecheck(): void {
    const now = this.now();
    let earliest = Infinity;
    for (const item of this.queue) {
      if (item.state === 'pending' && item.replayAt > now) earliest = Math.min(earliest, item.replayAt);
    }
    if (!Number.isFinite(earliest)) return;
    if (this.nextTimer !== undefined) clearTimeout(this.nextTimer);
    const delay = Math.max(earliest - now, 10);
    this.nextTimer = setTimeout(() => {
      this.nextTimer = undefined;
      void this.tick();
    }, delay);
    this.nextTimer.unref?.();
  }

  private renderText(item: Announcement, summary: string): string {
    return formatAnnouncement(item.category, {
      workspaceTitle: item.workspaceTitle,
      sessionTitle: item.sessionTitle,
      name: item.name,
      summary,
    });
  }

  // ── 队列 ──

  /** 插入（优先级降序；同优先级 FIFO —— 插到同 tier 末尾）。 */
  private insert(item: Announcement): void {
    const index = this.queue.findIndex((existing) => existing.priority < item.priority);
    if (index === -1) this.queue.push(item);
    else this.queue.splice(index, 0, item);
  }

  /** 放回同 tier 头部（barge-in 重播优先）。 */
  private insertAtTierHead(item: Announcement): void {
    const index = this.queue.findIndex((existing) => existing.priority <= item.priority);
    if (index === -1) this.queue.push(item);
    else this.queue.splice(index, 0, item);
  }

  private isDuplicate(key: string, now: number): boolean {
    const last = this.recent.get(key);
    if (last === undefined) return false;
    return now - last < this.deps.config.dedupeWindowMs;
  }

  private pruneRecent(now: number): void {
    for (const [key, ts] of this.recent) {
      if (now - ts >= this.deps.config.dedupeWindowMs) this.recent.delete(key);
    }
  }

  /** DND/静音时段闸：该分类是否应静音（确认类默认永不静音）。 */
  private shouldSilence(category: FeedbackCategory): boolean {
    if (category === 'need-confirm') {
      // 确认类：默认永不静音；只有显式 dnd + confirmNeverSilent=false 才静音
      return this.deps.config.dnd && !this.deps.config.confirmNeverSilent;
    }
    return this.deps.config.dnd || isQuietNow(this.deps.config.quietHours, this.now());
  }

  /** DND/静音时段解除后：把 deferred 项恢复为 pending（立即可播，无需冷却）。 */
  private requeueDeferred(): void {
    const now = this.now();
    if (this.deps.config.dnd || isQuietNow(this.deps.config.quietHours, now)) return;
    for (const item of this.queue) {
      if (item.state === 'deferred') {
        item.state = 'pending';
        item.replayAt = now;
      }
    }
  }

  /** 下一条可播项：pending 且（非 DND 静音分类）且冷却已过。 */
  private peekSpeakable(): Announcement | undefined {
    const now = this.now();
    for (const item of this.queue) {
      if (item.state !== 'pending') continue;
      if (item.replayAt > now) continue;
      if (this.shouldSilence(item.category)) {
        // 任务类静音：标记 deferred（只入队不发声，恢复后补播）
        item.state = 'deferred';
        continue;
      }
      return item;
    }
    return undefined;
  }

  // ── 播报循环 ──

  /**
   * 串行播报循环：暂停正文（如需）→ 提示音 → 播插播 → 等播完（completeSpeech）
   * → 恢复正文 → 下一条。barge-in（interruptCurrent）→ 该项放回队列头，冷却后重播。
   */
  private async tick(): Promise<void> {
    if (this.busy) return;
    // 用户正在说话（T-6 置 listening）→ 不插播（等说完再补）
    if (this.deps.audio.state() === 'listening') return;
    const item = this.peekSpeakable();
    if (!item) return;
    this.busy = true;
    const myToken = this.interruptSeq;
    try {
      const state = this.deps.audio.state();
      const mainSpeaking = state === 'speaking' || state === 'broadcasting';
      if (mainSpeaking) {
        this.deps.audio.pause();
        this.pausedMain = true;
      }
      item.state = 'speaking';
      this.active = item;
      this.deps.audio.playTone(item.tone);
      if (this.interruptSeq !== myToken) throw new FeedbackInterruptedError();
      this.deps.audio.speak(item.text);
      if (this.deps.autoCompleteSpeech) queueMicrotask(() => this.completeSpeech(item.id));
      const ok = await this.waitSpeech(item);
      if (!ok) {
        // barge-in：队列保留可重播。项仍在队列中（peekSpeakable 不移除），
        // 只改状态 + 冷却；不要重新插入（否则重复）。
        this.pausedMain = false;
        if (this.active === item) {
          item.state = 'pending';
          item.replayCount += 1;
          item.replayAt = this.now() + REPLAY_BACKOFF_MS;
          if (item.replayCount > MAX_REPLAY_COUNT) {
            this.removeFromQueue(item.id); // 超限丢弃（防死循环）
            this.deps.logger?.(`[feedback] drop ${item.id} after ${item.replayCount} interruptions`);
          } else {
            this.scheduleRecheck();
          }
        }
      } else if (this.active === item) {
        // 播完：记为 spoken，从队列移除（历史已留），恢复正文（若之前暂停过）
        item.state = 'spoken';
        this.deps.logger?.(`[feedback] spoken ${item.id}`);
        this.pushHistory(item);
        this.removeFromQueue(item.id);
        this.recent.set(item.dedupeKey, this.now());
        if (this.pausedMain) {
          this.pausedMain = false;
          this.deps.audio.resume();
        }
      }
    } catch (error) {
      this.pausedMain = false;
      if (error instanceof FeedbackInterruptedError || (error instanceof Error && /interrupt/i.test(error.message))) {
        // 提示音/间隙被打断：项仍在队列中，改状态 + 冷却即可
        if (this.active === item) {
          item.state = 'pending';
          item.replayCount += 1;
          item.replayAt = this.now() + REPLAY_BACKOFF_MS;
          if (item.replayCount > MAX_REPLAY_COUNT) this.removeFromQueue(item.id);
          else this.scheduleRecheck();
        }
      } else {
        this.deps.logger?.(`[feedback] announce failed: ${String(error)}`);
      }
    } finally {
      if (this.active === item) this.active = null;
      this.busy = false;
    }
    // 继续下一条（微任务间隙，让 interrupt / 新事件有机会插入）
    void Promise.resolve().then(() => void this.tick());
  }

  /**
   * 等待当前插播播完：completeSpeech（客户端上报）→ true；interruptCurrent →
   * false；两者都未发生则按**文本长度估算的时长**超时（生产兜底：客户端未
   * 上报时不让队列卡死；T-8 接 client Playback 播完钩子后精确化）。
   */
  private waitSpeech(item: Announcement): Promise<boolean> {
    return new Promise((resolve) => {
      const timeoutMs = estimateSpeechMs(item.text);
      const timer = setTimeout(() => {
        if (this.speechWaiter?.itemId === item.id) {
          this.speechWaiter = null;
          resolve(true);
        }
      }, timeoutMs);
      timer.unref?.();
      this.speechWaiter = {
        itemId: item.id,
        resolve: (ok) => {
          clearTimeout(timer);
          resolve(ok);
        },
      };
    });
  }

  private removeFromQueue(id: string): void {
    const index = this.queue.findIndex((item) => item.id === id);
    if (index >= 0) this.queue.splice(index, 1);
  }

  // ── 内部辅助 ──

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private isOwnSession(sessionId: string): boolean {
    if (this.deps.config.announceOwnSessions) return false;
    return this.activeSessionId !== undefined && this.activeSessionId === sessionId;
  }

  private async resolveWorkspaceTitle(sessionId: string | undefined, cwd?: string): Promise<string | undefined> {
    if (sessionId === undefined) return undefined;
    const cached = this.workspaceCache.get(sessionId);
    if (cached !== undefined) return cached;
    if (!this.deps.resolveWorkspace) return undefined;
    try {
      const title = await this.deps.resolveWorkspace(sessionId, cwd);
      if (title) this.workspaceCache.set(sessionId, title);
      return title;
    } catch {
      return undefined;
    }
  }

  /** 会话标题：缓存（session/title 事件）→ resolveSessionTitle（sessions.list 投影）→ 懒缓存。 */
  private async resolveSessionTitleCache(sessionId: string): Promise<string | undefined> {
    const cached = this.sessionTitles.get(sessionId);
    if (cached !== undefined) return cached;
    if (!this.deps.resolveSessionTitle) return undefined;
    try {
      const title = await this.deps.resolveSessionTitle(sessionId);
      if (title) this.sessionTitles.set(sessionId, title);
      return title;
    } catch {
      return undefined;
    }
  }

  private pushHistory(item: Announcement): void {
    this.history.unshift(toView(item));
    if (this.history.length > HISTORY_CAP) this.history.length = HISTORY_CAP;
  }
}

/** 插播被打断（tick 内部信号；不是播报层的错误）。 */
export class FeedbackInterruptedError extends Error {
  constructor() {
    super('feedback announcement interrupted');
    this.name = 'FeedbackInterruptedError';
  }
}

// ─────────────────────────── 生产适配（T-5 状态机） ───────────────────────────

/**
 * 把 T-5 {@link VoiceStateMachine} 适配为 {@link FeedbackAudio}：
 *
 * - pause/resume/stop/speak → 机器同名方法（speak 走 'speak' 事件 → TTS 通道）；
 * - playTone → `tonePlayer.play(tone)`（缺省 no-op + log；T-8 接 client 提示音）；
 * - state() → `machine.current`。
 *
 * 播完信号不在本适配内（T-5 状态机 speak 为 fire-and-forget）：生产装配在
 * index.ts 把客户端 `/voice.feedback {action:'spoken'}` 接到引擎
 * `completeSpeech()`；客户端播完即上报。测试注入 fake audio 或显式 completeSpeech。
 */
export interface TonePlayer {
  play(tone: ToneId): void;
}

// ─────────────────────────── 事件源接线 ───────────────────────────

/**
 * 五事件源订阅（host，index.ts 在 apply 中调用）。
 *
 * - `session/event`：别会话 `turn/end`(completed) + `assistant/message` →
 *   task-done；`approval/asked` → need-confirm；`session/title` → 标题缓存；
 * - `ctx.jobs.onJobDone`：jobs 域 settled → task-done / task-error（守卫缺失）；
 * - `ctx.userQuestions.ask` 包装：questions 域 ask() → need-confirm（守卫缺失）。
 *
 * 工作区标题解析：默认经 `ctx.apiProxy.workspace.list()` 懒缓存（loopback 权威，
 * 参照 T-3 session-ctrl 的网关姿势）；`deps.resolveWorkspace` 可覆盖（测试注入）。
 * 所有订阅随 ctx.effect 回收；返回引擎实例供 RPC / 命令共享。
 */
export interface FeedbackInstallOptions {
  readonly config: FeedbackConfig;
  readonly audio: FeedbackAudio;
  readonly logger?: (message: string) => void;
  readonly resolveWorkspace?: (sessionId: string, cwd?: string) => Promise<string | undefined>;
  readonly resolveSessionTitle?: (sessionId: string) => Promise<string | undefined>;
}

export function installFeedback(
  ctx: Context,
  options: FeedbackInstallOptions,
): FeedbackEngine {
  const engine = new FeedbackEngine({
    audio: options.audio,
    config: options.config,
    logger: options.logger,
    resolveWorkspace: options.resolveWorkspace ?? defaultWorkspaceResolver(ctx),
    resolveSessionTitle: options.resolveSessionTitle ?? defaultSessionTitleResolver(ctx),
  });
  const logger = options.logger ?? (() => {});

  // 1) session/event（别会话完成 / approval / 标题缓存）
  ctx.effect(() =>
    ctx.on('session/event', (session: SessionLike, event: SessionEventLike) => {
      engine.handleSessionEvent(session, event);
    }),
  'dsh-localvoice: feedback session/event');

  // 2) jobs 域 settled（守卫缺失：无 ctx.jobs 的宿主不接 jobs 源）
  const jobs = ctx.get('jobs') as { onJobDone?: (listener: (snapshot: JobSnapshotLike) => void) => () => void } | undefined;
  if (jobs?.onJobDone) {
    ctx.effect(() => jobs.onJobDone!((snapshot) => engine.handleJobSettled(snapshot)),
      'dsh-localvoice: feedback jobs');
  } else {
    logger('[feedback] ctx.jobs 不可用 — jobs 事件源跳过');
  }

  // 3) questions 域 ask() 包装（守卫缺失；包装随 effect 还原）
  const questions = ctx.get('userQuestions') as unknown as
    | { ask: (request: { agent?: { id?: string }; questions: readonly { text?: string; title?: string }[] }) => Promise<unknown> }
    | undefined;
  if (questions) {
    const originalAsk = questions.ask.bind(questions);
    questions.ask = (request) => {
      engine.handleQuestionAsked({ sessionId: request.agent?.id, questions: request.questions });
      return originalAsk(request);
    };
    ctx.effect(() => () => {
      questions.ask = originalAsk;
    }, 'dsh-localvoice: feedback questions wrap');
  } else {
    logger('[feedback] ctx.userQuestions 不可用 — questions 事件源跳过');
  }

  return engine;
}

/** 会话/事件的最小形状（与 @deepseek-ai/dsh-session 结构兼容，避免强耦合）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface SessionLike { readonly id: string; readonly header?: { readonly cwd?: string } }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SessionEventLike = { type: string; [key: string]: any };

/** 从 assistant 消息 content 提取纯文本（字符串/多段/数组兜底）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractMessageText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

/** jobs 快照的最小形状（结构兼容 @deepseek-ai/dsh-jobs 的 JobSnapshot）。 */
export interface JobSnapshotLike {
  readonly status: string;
  readonly label?: string;
  readonly detail?: string;
  readonly ownerSession?: string;
  readonly id?: string;
}

function dedupeKey(sessionId: string | undefined, category: string, summary: string): string {
  // 作用域 = 会话（每对话各自计时）；内容指纹 = 摘要文本（同样提示不重复，
  // 不同提示各自响）。category 保留：不同提醒类型不算"同样"。
  return `${sessionId ?? '*'}:${category}:${summary.trim()}`;
}

function toView(item: Announcement): AnnouncementView {
  return {
    id: item.id,
    category: item.category,
    priority: item.priority,
    tone: item.tone,
    text: item.text,
    state: item.state,
    sessionId: item.sessionId,
    own: item.own,
    workspaceTitle: item.workspaceTitle,
    sessionTitle: item.sessionTitle,
    name: item.name,
    source: item.source,
    createdAt: item.createdAt,
    replayable: item.replayable,
  };
}

function fromView(view: AnnouncementView): Announcement {
  return {
    id: view.id,
    category: view.category,
    priority: view.priority,
    tone: view.tone,
    text: view.text,
    dedupeKey: `${view.id}:replay`,
    sessionId: view.sessionId,
    own: view.own,
    workspaceTitle: view.workspaceTitle,
    sessionTitle: view.sessionTitle,
    name: view.name,
    source: view.source,
    createdAt: view.createdAt,
    replayAt: 0,
    replayCount: 0,
    replayable: view.replayable,
    state: 'pending',
  };
}

// ─────────────────────────── 工作区标题解析 ───────────────────────────

/** 宿主 apiProxy.workspace.list 的最小形状（结构兼容 @deepseek-ai/dsh-host-apiproxy）。 */
export interface WorkspaceListApi {
  list(request: { rpcId: unknown; payload: Record<string, never> }): Promise<{
    result: {
      ok: boolean;
      value?: { items?: readonly { workspaceId: string; title: string; sessionIds?: readonly string[] }[] };
    };
  }>;
}

/** 默认工作区标题解析：workspace.list() → sessionId 所在工作区 title；cwd basename 兜底。 */
export function defaultWorkspaceResolver(
  ctx: Context,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiProxy: { workspace?: WorkspaceListApi } | undefined = (ctx as any).apiProxy,
): (sessionId: string, cwd?: string) => Promise<string | undefined> {
  let cache: Map<string, string> | undefined;
  return async (sessionId, cwd) => {
    if (apiProxy?.workspace?.list) {
      try {
        cache ??= await loadWorkspaceTitles(apiProxy.workspace);
        const hit = cache.get(sessionId);
        if (hit) return hit;
      } catch {
        // 宿主清单不可用 → cwd basename 兜底
      }
    }
    return cwd ? basename(cwd) : undefined;
  };
}

async function loadWorkspaceTitles(api: WorkspaceListApi): Promise<Map<string, string>> {
  const response = await api.list({ rpcId: makeRpcId(), payload: {} });
  if (!response.result.ok) return new Map();
  const map = new Map<string, string>();
  for (const workspace of response.result.value?.items ?? []) {
    for (const sessionId of workspace.sessionIds ?? []) {
      map.set(sessionId, workspace.title);
    }
  }
  return map;
}

/** 宿主 apiProxy.sessions.list 的最小形状（结构兼容 @deepseek-ai/dsh-host-apiproxy）。 */
export interface SessionListApi {
  list(request: { rpcId: unknown; payload: Record<string, never> }): Promise<{
    result: {
      ok: boolean;
      value?: {
        items?: readonly {
          sessionId: string;
          projections?: { values?: Readonly<Record<string, unknown>> };
        }[];
      };
    };
  }>;
}

/** 默认会话标题解析：sessions.list() → `session/title` 投影；宿主不可用 → undefined。 */
export function defaultSessionTitleResolver(
  ctx: Context,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiProxy: { sessions?: SessionListApi } | undefined = (ctx as any).apiProxy,
): (sessionId: string) => Promise<string | undefined> {
  let cache: Map<string, string> | undefined;
  return async (sessionId) => {
    if (!apiProxy?.sessions?.list) return undefined;
    try {
      cache ??= await loadSessionTitles(apiProxy.sessions);
      return cache.get(sessionId);
    } catch {
      return undefined;
    }
  };
}

async function loadSessionTitles(api: SessionListApi): Promise<Map<string, string>> {
  const response = await api.list({ rpcId: makeRpcId(), payload: {} });
  if (!response.result.ok) return new Map();
  const map = new Map<string, string>();
  for (const item of response.result.value?.items ?? []) {
    const title = sessionTitleOf(item);
    if (title) map.set(item.sessionId, title);
  }
  return map;
}

/**
 * 从 session.list 条目提取会话标题（`title` 投影：纯字符串，见
 * @deepseek-ai/dsh-session-title —— 键是 'title' 不是 'session/title'，
 * 值是 string 不是对象；侧边栏显示用的同一投影）。无标题返回 undefined。
 */
function sessionTitleOf(item: { projections?: { values?: Readonly<Record<string, unknown>> } }): string | undefined {
  const title = item.projections?.values?.['title'];
  return typeof title === 'string' && title !== '' ? title : undefined;
}

/** 生成一次宿主 RPC 调用 id（与 T-3 rpc.ts 相同的降级姿势）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRpcId(): any {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

// ─────────────────────────── 工具函数 ───────────────────────────

/** "HH:mm" → 分钟数（非法输入返回 -1）。 */
export function toMinutes(hhmm: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return -1;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return -1;
  return hour * 60 + minute;
}

/** 是否处于静音时段（start>end 视为跨夜；空串 = 无时段）。 */
export function isQuietNow(quiet: FeedbackConfig['quietHours'], now: number | Date): boolean {
  if (!quiet?.start || !quiet?.end) return false;
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start < 0 || end < 0) return false;
  const date = now instanceof Date ? now : new Date(now);
  const current = date.getHours() * 60 + date.getMinutes();
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

/** 插播播报时长估算（ms）：提示音 + 文本合成播放；上下限夹紧。 */
export function estimateSpeechMs(text: string): number {
  const chars = text.length;
  // 中文播报 ~150ms/字 + 提示音 ~300ms；下限 800ms 防过短，上限 30s 防挂起
  return Math.min(Math.max(800, chars * 150 + 300), 30_000);
}

/**
 * 一句话摘要兜底：取回复首段（FR-6 插播摘要的降级路径）。
 *
 * - 去掉 markdown 噪音行（#、```、列表符号、引用）；
 * - 取第一个有实质内容的段落；
 * - 长度上限 maxLen（默认 60）字，超出截断加省略号（口语播报够用即可）。
 */
export function firstParagraph(text: string, maxLen = 60): string {
  const clean = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^[#>*-]/.test(line) && !line.startsWith('```'))
    .join(' ');
  if (clean.length === 0) return '（无摘要）';
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen)}…`;
}
