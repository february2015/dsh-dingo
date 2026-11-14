# dsh-dingo 2.4

[English](README.md) | **中文**

> **2.4.0（2026-11-13）适配 DSH 0.2.2**
>
> - **能装进 0.2 了**：宿主 `apiProxy` 在 0.2 已被拆掉，改为 `ctx.get()` 软取；`/dingo` RPC 改用 `webServer` 作用域上下文注册（无 webserver 的宿主静默跳过）；客户端 inject 去掉已删除的 `dsh-client-runtime`，补 `dsh-client-ui-workspace` / `dsh-api-session-controller`。
> - **跨项目**：每 5 秒读一次宿主 `sessionController.list()`（全量、活跃度序、与 GUI 侧栏同源），把别的工作区里在跑的 / 10 分钟内刚结束的会话补进药丸（上限 40 张）。
> - **手机**：视口 ≤ 900px 时药丸从侧栏 footer 切成**右上角固定浮层**（ReactDOM 自建 fixed 容器，不依赖槽位），点开是同一份跨项目卡片列表；点卡片优先走 `uiWorkspace.openSession`，可跨工作区跳转。宽屏/窄屏两个实例互斥挂载，不会重复轮询、重复放提示音。
> - **标题与跳转**：跨工作区的会话标题不在当前客户端 store 里，宿主改从 `~/.dsh/storages/session_projcache/sessions/<id>.json` 的 `record.rows.title.val` 读（带 mtime 缓存）；点击卡片改为**每次现取** `uiWorkspace`（apply 时它常常还没就绪，闭包捕获会永久失效），并同时尝试 `openSession(id)` / `openSession({sessionId})` 两种形状，全失败会打 `[dsh-dingo]` 告警而不是静默。
> - **RPC 自注册**：本版 DSH 的 `connection.rpc.handle` 不可用（其 `owner.webServer` 锚定在 connection 服务自己的 fiber 上，永远解析不到 `webServer`，调用必抛 `cannot get property "webServer" without inject`）。改成插件自己 `ctx.webServer.register({kind:'prefix', path:'/dingo'})` 并按 dsh-client-connection 的线上协议手写信封（见 `src/rpc-route.ts`），客户端 `connection.rpc.call` 一行不改。

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

> 位置说明：DSH 是三栏布局——**左侧边栏**（工作区/会话列表、设置）｜**中间会话列**｜**右侧详情列**。
> 统计胶囊（全宽条）位于**左侧边栏的底部**，是 footer 区最上面的一行独立横条：在**底部功能按钮**（如 Cordis 面板图标）的**上方**、**设置按钮**（齿轮）的**上方**。

- 左侧边栏底部会看到一条**独立全宽横条**（统计胶囊）：**独占一行**，位于底部功能按钮（Cordis 面板等，换行排在它下面）与设置按钮之上；显示当前活跃会话的状态统计——
  - 异常红点+数量 / 疑问橙点+数量 / 执行中 spinner+数量 / 中间输出 / 等待后台 / 正常计数（图标紧贴数字，单元间留空隙）；
  - 有需要处理的状态时整条呼吸/辉光闪烁（异常最快最猛）；
  - 右侧显示「N 个活跃会话」。
  - **空态补位**：没有任何活跃会话（如刚重启、事件还没产生）时横条常显，显示灰点 + `0`，点开面板显示「暂无活跃会话」——不会凭空消失。
  - **加载即显示**：无需等新事件——执行中 / 待你回答 / 已完成未读 / 草稿 / 后台任务等状态由客户端从会话快照直接判定，host 事件到达后自动合并去重。
  - 会话头部操作行保留：工作区名称标签、`Rename` 按钮（自动命名）。
- 鼠标悬停/点击统计胶囊，会**向上展开详细卡片面板**（面板从横条向上弹出）：
  - 第一行：工作区名（如有未完成后台任务，会显示小 spinner + 数量）；
  - 第二行：对话名；
  - 不同状态不同颜色；
  - 点击卡片直达对应对话；
  - × 关闭仅移除本次卡片。
- 面板 5 秒无操作自动关闭，也可以点击统计胶囊手动开关；
- 横条常驻侧边栏底部，**新开 DSH / 空白首页（hero）时同样可见**；侧边栏收起为 56px rail 时压成紧凑小图标；
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
