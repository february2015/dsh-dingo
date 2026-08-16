# dsh-dingo 2.0

[English](README.md) | **中文**

**Ding + Go** —— DSH（DeepSeek Harness）声音提醒 + 会话卡片 + 自动命名插件。

2.0 把原来的“事件驱动小卡片”升级为**会话 1:1 常驻卡片**：每个活跃对话一张卡片，实时反映状态，并支持自动命名。

---

## 功能一览

- 会话 1:1 卡片（常驻，状态实时更新）
- 多状态颜色/图标区分
- 紧凑统计胶囊 + 悬浮详细面板
- 跨会话草稿检测
- 等待后台/子任务/蜂群状态识别
- 当前工作区名称标签
- 后台任务数量显示
- 自动命名（按钮 / 对话内自然语言 / 命令）
- 声音提醒 + 系统通知 + 深链直达（1.x 能力保留）

---

## 状态与优先级

![状态优先级](docs/assets/priority.svg)

| 优先级 | 状态 | 含义 | 颜色 |
|---|---|---|---|
| 1 | 异常 | 任务失败 / 异常结束 | 红 |
| 2 | 疑问 | 需要你回答 | 橙 |
| 3 | 草稿 | 非当前对话有未发送输入 | 紫 |
| 4 | 待阅读 | 已完成且需要阅读 | 绿 |
| 5 | 等待后台/子任务/蜂群 | 主对话完成，但后台/子任务/蜂群仍在跑 | 青 |
| 6 | 中间输出 | 执行中且已有部分内容 | 浅蓝 |
| 7 | 执行中 | 正在执行 | 蓝 spinner |
| 8 | 正常 | 已完成且已看过 | 灰 |

> 当前对话正在输入内容属于正常状态，不触发顶部草稿提醒；切到其它对话后原对话草稿会恢复紫色提醒。

---

## 卡片怎么用

- 在对话头部操作行会看到：
  - 工作区名称标签：当前对话所属工作区；
  - `Rename` 按钮：自动命名当前对话；
  - 统计胶囊：显示当前所有活跃会话的状态统计。
- 鼠标悬停/点击统计胶囊，会展开**详细卡片面板**：
  - 第一行：工作区名（如有未完成后台任务，会显示小 spinner + 数量）；
  - 第二行：对话名；
  - 不同状态不同颜色；
  - 点击卡片直达对应对话；
  - × 关闭仅移除本次卡片。
- 面板 5 秒无操作自动关闭，也可以点击统计胶囊手动开关；
- 子代理 / Worker 会话不会出现在卡片清单里。

![统计胶囊](docs/assets/stats-pill.svg)

![详细卡片面板](docs/assets/card-panel.svg)

---

## 自动命名

| 入口 | 方式 |
|---|---|
| `Rename` 按钮 | 独立调用 DeepSeek V4 Flash 生成标题 |
| 对话内自然语言 | 主 LLM 在当前上下文生成标题后调用 `rename_current_session` 工具改名 |
| `/dingo rename` | 兜底命令，走独立 Flash 逻辑 |

生成规则：

- 只取最近 5 条用户消息；
- 中文 6~20 字 / 英文 3~12 词；
- 标题要有区分度，避免“帮我/优化/请问”等雷同前缀；
- 只输出标题本身。

---

## 与 TaskSwarm（蜂群）配合

dsh-dingo 可以和 [dsh-taskswarm](https://github.com/february2015/dsh-taskswarm) 配合：

- TaskSwarm 通过标准 Cordis 服务暴露 `ctx.get('taskswarm')`；
- dsh-dingo 会读取其中的活跃批次；
- 如果某个主对话发起的蜂群还在跑，即使主对话已经完成，卡片也会显示**等待后台/子任务/蜂群**状态；
- 这样你在卡片面板里就能看到“主对话已完成，但蜂群还在跑”的未完成状态。

两个插件可以独立使用，也可以组合使用。

---

## 命令

```
/dingo on|off        # 开/关提醒
/dingo status        # 查看开关、DND、队列状态
/dingo dnd [on|off]  # 免打扰
/dingo rename        # 自动命名当前对话（兜底）
```

---

## 安装

```bash
# 本地源码安装（开发）
dsh plugin --profile web add /path/to/dsh-dingo

# 或 npm 安装（发布后）
dsh plugin --profile web add dsh-dingo
```

DSH profile 通过 `link:/path/to/dsh-dingo` 指向本仓库时，重启 DSH 后生效。

---

## 配置

```yaml
- id: dsh-dingo
  config:
    enabled: true
    feedback:
      toneStyle: soft
      dnd: false
      dedupeWindowMs: 10000
      quietHours: { start: '', end: '' }
    # systemNotify: true
    # systemNotifyBaseUrl: ''
```

---

## 开发

```bash
npm install
npm run typecheck
npm test
npm run verify
```

更多实现细节见 [docs/v2-features.md](docs/v2-features.md) 和 [docs/dsh-plugin-dev-tips.md](docs/dsh-plugin-dev-tips.md)。

## License

MIT
