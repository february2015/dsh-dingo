# DSH Plugin 开发技巧与踩坑总结

> 适用项目：dsh-dingo（以及其他 DSH Cordis 插件）
> 目的：把多次开发中遇到的问题沉淀下来，避免重复踩坑。

## 1. Cordis 服务访问：`ctx.xxx` 必须声明 `inject`，可选服务用 `ctx.get()`

### 问题现象

直接访问某个服务属性，启动时报错：

```
Error: cannot get property "tools" without inject
    at installRenameTool ...
```

### 原因

Cordis 的 `ctx` 是代理对象。插件 `apply(ctx)` 里直接访问 `ctx.tools`、`ctx.connection`、`ctx.apiProxy` 等，**必须先在插件的 `inject` 数组里声明**，否则 Cordis 不允许直接读取。

### 正确做法

| 场景 | 做法 |
|---|---|
| 该服务是插件必需依赖 | 在 `export const inject = ['connection', 'apiProxy', ...]` 里声明，然后直接 `ctx.connection` |
| 该服务是可选/可能不存在 | 用 `ctx.get('tools')` 获取，拿不到就 `undefined`，安全跳过 |
| 不确定是否存在 | 优先 `ctx.get()`，不要直接 `ctx.xxx` |

示例：

```ts
// 错误：没有在 inject 声明 tools，直接访问会崩
const tools = ctx.tools

// 正确：可选服务用 ctx.get
const tools = ctx.get('tools')
if (!tools?.register) return
```

### 容易踩到的服务

- `tools`：工具注册服务
- `commands`：斜杠命令服务
- `sessions`、`userQuestions`、`jobs`：不同宿主可能没有
- `sessionTitle`：标题服务
- `llm`：LLM 服务
- `apiProxy`：如果声明了 inject 才能直接访问

## 2. Host 侧调用 apiProxy 要用 RPC 窄格式

### 问题现象

调用 `apiProxy.sessions.rename(...)` 或 `history(...)` 时，如果直接传业务对象：

```ts
api.sessions.rename({ sessionId, title })
```

会报类似：

```
Cannot destructure property 'sessionId' of 'request.payload' as it is undefined
```

### 原因

`ctx.apiProxy` 是宿主侧 ApiProxy 实现面，方法签名是：

```ts
rename(request: { rpcId: unknown; payload: { sessionId: string; title: string } })
```

不是客户端那种“直接传 payload”的形态。

### 正确写法

```ts
const rpcId = makeRpcId()

await api.sessions.history({
  rpcId,
  payload: { sessionId, maxMessages: 20 },
})

await api.sessions.rename({
  rpcId,
  payload: { sessionId, title },
})
```

`makeRpcId()` 可以用：

```ts
function makeRpcId(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
```

## 3. 改完源码必须重新 build

### 问题现象

本地 DSH profile 通过 `link:/path/to/dsh-dingo` 指向仓库，但 DSH 加载的是 `lib/` 下的构建产物，不是 `src/`。

如果只改 `src/` 不执行 `npm run build`，重启 DSH 后跑的仍是旧代码。

### 正确流程

```bash
npm run verify
# 或至少
npm run build
```

然后重启 DSH。

## 4. Host 侧改动通常需要重启 DSH

- Client 前端（React 组件、样式）在开发模式下可能可以 HMR。
- Host 侧（RPC、服务注册、工具注册、事件订阅）属于插件生命周期，**结构变了必须重启 DSH**。
- 如果当前 shell 是 DSH 的子进程，不要在里面直接杀 DSH，否则会把自己的会话也杀掉；建议在外部终端重启。

## 5. 注册工具 / 命令 / 槽位时注意服务是否存在

### 工具

```ts
const tools = ctx.get('tools')
if (!tools?.register) return
ctx.effect(() => tools.register(tool), 'plugin: tool')
```

### 命令

```ts
const commands = ctx.get('commands')
if (!commands?.register) return
commands.register({ ... })
```

### 客户端槽位

- 使用 `ctx.slots.inject('slot.name', () => ctx.slots.register({ ... }, Component))`
- 槽位名必须与对应包的 SlotMap 声明匹配
- 类型导入用来加载 SlotMap 增强，不能省略

## 6. RPC 通道注意 authority

- `/dingo` 默认 `loopback` 只信任回环来源。
- 如果通过域名/远程访问，需要在 profile patch 里配置：

```yaml
- id: dsh-dingo
  config:
    channelAuthority: trusted-host
```

## 7. 新增 host 能力时，记得同步暴露给 agent

- 如果希望主 LLM 能调用某个能力，需要注册成 **tool**（`ctx.tools`），不是只加 RPC。
- 如果希望用户能用斜杠命令，需要注册成 **command**（`ctx.commands`）。
- 如果希望 UI 有入口，需要注册 **client slot**。

## 8. 测试与验证

- `npm run typecheck`
- `npm test`
- `npm run build`
- 涉及 RPC / 工具时，补对应单测
- 涉及 client 槽位时，至少保证 build 通过

## 9. 常见错误速查

| 错误 | 原因 | 解决 |
|---|---|---|
| `cannot get property "xxx" without inject` | 直接访问未 inject 的服务 | 改为 `ctx.get('xxx')` 或加入 `inject` |
| `Cannot destructure property 'sessionId' of 'request.payload' as it is undefined` | 把 apiProxy 当客户端 API 直接传 payload | 改成 `{ rpcId, payload: { ... } }` |
| `unknown /dingo endpoint` | RPC endpoint 未注册 | 在 `installDingoRpc` 的 switch 里加 case |
| `failed to apply loader entry` | 插件 apply 阶段抛错 | 看堆栈第一个业务错误，通常是服务访问/类型问题 |
| 改了代码没生效 | DSH 加载的是 `lib/` | 先 `npm run build` 再重启 |
| 远程访问 RPC 403 | authority 仍是 loopback | profile patch 改为 `trusted-host` |
