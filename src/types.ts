/**
 * dsh-dingo — 共享类型（host/client 双半共用）。
 *
 * 声音提醒插件：当前对话回复当/当当（crisp 档）区分，其他对话叮/叮叮（soft 档）+ 右上角卡片直达。
 *
 * @module dsh-dingo/types
 */

/**
 * 插件配置（已应用 schemastery 默认值的解析形状）。
 * schema 定义在 `src/index.ts`（`Config` 常量）。
 */
export interface Config {
  feedback: {
    /** 总开关（false = 事件只忽略，不产生任何提醒）。 */
    enabled: boolean;
    /** DND 免打扰（`/dingo dnd on|off`，live 可变）。 */
    dnd: boolean;
    /** 确认类（需回答）默认永不静音。 */
    confirmNeverSilent: boolean;
    /** 去重窗口（ms，默认 10000）：同会话同内容窗口内去重（不同样各自响）。 */
    dedupeWindowMs: number;
    /** 同会话自身事件是否也插播（默认 false = 当前对话自身事件由"当/当当"提示音处理）。 */
    announceOwnSessions: boolean;
    /** 静音时段（"HH:mm" 24h；空串 = 无；start>end 视为跨夜）。 */
    quietHours: { start: string; end: string };
    /** 提示音档位（soft 柔和"叮" / crisp 清脆"当"；当前对话固定 crisp）。 */
    toneStyle: 'soft' | 'crisp';
  };
  /** `/dingo on|off` 开关（默认开；运行时内存态，重启回默认）。 */
  enabled: boolean;
  /** 系统级通知总开关（macOS 通知中心 / Windows toast）。 */
  systemNotify: boolean;
  /** 系统通知深链基地址（空串 = 自动取宿主自述地址）。 */
  systemNotifyBaseUrl: string;
}

/** 播报状态机状态（提醒插件恒 idle/非 listening；feedback 音频端口用）。 */
export type VoiceState = 'idle' | 'listening' | 'thinking' | 'tooling' | 'speaking' | 'broadcasting';

/** 当前对话提醒级别（由回复文本判定）。 */
export type NoticeLevel = 'reply' | 'confirm';

/** 提示音标识（与 client tones.ts 对应）。 */
export type ToneId = 'ding' | 'ding-ding' | 'dong' | 'none';

/**
 * `/dingo.sessions` 返回的一条会话摘要（host → client 补卡用）。
 *
 * 存在的理由：窄屏浮层胶囊是插件自己用 ReactDOM 挂的，拿不到侧栏槽位的
 * `useSessions`，于是"只有草稿、没有活跃事件"的会话在手机上补不出来。
 * 宿主本来每 5 秒就会调一次 `sessionController.list()`，顺手把它转成这份紧凑清单
 * 暴露给客户端即可，零额外成本。
 */
export interface DingoSessionSummary {
  /** 会话 id。 */
  readonly sessionId: string;
  /** 标题（`title` 投影优先，其次投影缓存）。 */
  readonly title?: string;
  /** 工作目录（客户端取其 basename 当工作区名）。 */
  readonly cwd?: string;
  /** 宿主判定是否正在执行。 */
  readonly running?: boolean;
  /** 最后活跃时间（epoch ms）。 */
  readonly updatedAt?: number;
  /** 子代理会话标记（客户端要过滤掉）。 */
  readonly origin?: 'subagent';
  /** 直接父会话（子代理的归属）。 */
  readonly parentSessionId?: string;
}

/** `/dingo.sessions` 响应。 */
export interface DingoSessionList {
  readonly items: readonly DingoSessionSummary[];
}
