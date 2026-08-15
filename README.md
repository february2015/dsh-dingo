# dsh-dingo

**Ding + Go** —— DSH（DeepSeek Harness）声音提醒 + **对话直达**插件。

听到即到达：其他对话回复时出声提醒你，右上角卡片**点一下直达对应对话**——不只是告诉你"有动静"，而是直接把你送到对话面前（这是区别于纯提醒方案的核心能力）。

**多对话并行时的得力助手**：DSH 里同时开好几个对话（含子代理）并行干活时，不用挨个盯着——哪个对话有回复，出声提醒你 + 卡片标注工作区/对话名；点一下直达那个对话，处理完继续干别的。提醒不打扰，直达不迷路，多任务并行也能从容切换。

当前对话回复 → **当 / 当当** 提示音区分（crisp 清脆档）；其他对话回复 → **另一套声音（叮，soft 柔和档）** + 右上角**小卡片**，点击卡片**直达**对应对话。无 ASR、无 TTS、无语音合成——纯事件驱动，轻量。

---

## 它到底做了什么

| 场景 | 声音 | 卡片 |
|---|---|---|
| **当前对话**有回复（普通陈述） | 当（1 声，crisp 档） | 无（你正在看这个对话） |
| **当前对话**需回答（回复含疑问/请求确认） | 当当（2 声，crisp 档） | 无 |
| **其他对话**有回复 | 另一套声音（叮，soft 档）1 声 | ✅ 右上角小卡片 |
| **其他对话**需回答 | 另一套声音 2 声 | ✅ 右上角小卡片 |
| 任务失败 | 咚（低音） | ✅ 小卡片 |

**"需回答"怎么判定**（2026-08-15 收紧）：优先看**结构化信号**——`ask_user` 工具调用、审批请求（`approval/asked`）、questions 域提问 → 一律"需回答"。纯文本兜底判定更严格，避免把 AI 思考过程中的自问自答误判成"等你回答"：
- 明确请求动作/决策/确认（请确认、请选择、需要你拍板、你怎么看、你觉得呢…）→ 需回答；
- 问号 + 疑问语气（吗/呢/怎么/是否…）→ 需回答，但**排除**反问句（难道…吗？）、自问自答（…吗？因为/其实…）、问题清单列举（…？其次…）；
- 疑问词只出现在陈述句里（无问号，"我在想是否需要优化…"）→ 有回复。

**小卡片**（其他对话专属）：
- 固定 200×56 尺寸，半透明悬浮；
- 内容：状态图标 + 工作区名（≤12 字）+ 对话标题（≤10 字）；
  - 🟩 绿方块 = 有回复，🟠 问号 = 需回答，🔴 感叹号 = 失败；
- **点击卡片 → 直达该对话**；右上角 **× 关闭**；
- 多卡片从右上角（Session log 按钮下方）**从上往下排列**，间距 8px；点击跳转后其余卡片自动补位；
- 播报完成后卡片仍保留 30 秒供你点击/关闭，超时自动消失。

**提醒纪律**：
- 同一对话**同样的提示** 10 秒内不重复（按内容去重：不同样的提示各自响；每个对话各自计时）；
- `/dingo dnd on` 免打扰：任务完成类静音、需回答类仍提醒；
- 可配静音时段（`quietHours` "HH:mm"，支持跨夜）——任务类只入队不发声，结束后补播；
- `/dingo off` 一键关闭全部提醒。

---

## 安装

```bash
# 本地源码安装（开发）
dsh plugin --profile web add /path/to/dsh-dingo

# 或 npm 安装（发布后）
dsh plugin --profile web add dsh-dingo

# <profile> 换成你要安装的目标 profile 名（本机常用 web）
```

profile 的 `cordis.patch.yml` 或插件配置里可覆盖：

```yaml
- id: dsh-dingo
  config:
    enabled: true
    feedback:
      toneStyle: soft        # 提示音档位：soft（其他对话"叮"）/ crisp（当前对话"当"）
      dnd: false
      dedupeWindowMs: 10000  # 同会话同内容去重窗口（同样提示不重复、不同样各自响）
      quietHours: { start: '', end: '' }
```

## 命令

```
/dingo on|off        # 开/关提醒
/dingo status        # 开关、DND、插播队列
/dingo dnd [on|off]  # 免打扰（任务完成类静音、需回答仍提醒）
```

## 技术实现（架构）

- **host 半**（`src/index.ts` + `src/feedback.ts`）：
  - 订阅 `session/event`：`turn/end(completed)` / `approval/asked` / `tool/call(ask_user)` / `assistant/message` → 判定级别 → 入提醒队列（优先级：需回答 > 有回复 > 失败）；
  - 当前对话回复（客户端上报的当前查看会话）→ 直接入队 own 提醒（只播提示音、不显示卡片）；
  - 队列按优先级串行播报，客户端 `spoken` 上报后播下一条；
- **client 半**（`src/client/FeedbackCard.tsx` + `tones.ts`）：
  - 轮询 `/dingo.feedback` 快照 → 当前对话项播 crisp 档提示音（当/当当）、其他对话项播 soft 档（叮） + 渲染卡片；
  - 内置两套提示音（soft/crisp，data URL WAV），不依赖任何外部音频文件；
  - 点击卡片 → client 侧 `sessions.open` 直达对应对话（与侧边栏点击同一入口）。
- **RPC**（`/dingo` 通道）：`feedback` / `set-current-session`。

无 ASR、无 TTS、无 sidecar、无本地模型——提醒插件不需要"听懂"或"说出"任何内容。

## 开发

```bash
npm install
npm run typecheck   # 类型检查
npm test            # vitest
npm run verify      # typecheck + test + build
```

## License

MIT
