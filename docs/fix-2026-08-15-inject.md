# 2026-08-15 排障记录：安装 dsh-dingo 后 DSH 无法启动

> 记录一次真实事故：插件安装后 DSH 起不来 → 定位到 cordis 依赖声明缺失 →
> 补 `inject` 修复 → 回归测试固化。供后续排查同类"插件装上就起不来"问题参考。

## 背景

- 仓库初版提交：`0d0d975`（2026-08-15 22:55）
- 安装方式：`link:` 依赖进 web profile（开发模式，symlink 指向本地仓库）

```jsonc
// ~/.dsh/profiles/web/package.json
"dsh": {
  "profile": {
    "bundles": [ /* ... */ "dsh-dingo" ]
  }
},
"dependencies": {
  "dsh-dingo": "link:/Users/robin/myProject/dsh-dingo"
}
```

- 安装后：**DSH 起不来**（启动阶段插件初始化报错）。

## 根因

插件在 `apply` 阶段就读取宿主服务：

- `ctx.apiProxy` —— `src/feedback.ts` 解析工作区/会话标题（懒缓存入口）；
- `ctx.connection` —— `src/rpc.ts` 注册 `/dingo` RPC 通道。

但插件**没有声明对这两个服务的依赖**。cordis 按依赖顺序初始化插件，
未声明 `inject` 时宿主服务就绪顺序无保证 → 插件启动时读到未就绪的服务 →
初始化报错 → 整个 DSH 起不来。

**这是 cordis 插件开发的经典坑**：凡是 `apply` 里直接读 `ctx.<service>`，
必须在模块导出 `inject` 声明它。

## 修复

`src/index.ts` 顶部新增：

```ts
/** 插件初始化前必须可用的宿主服务。 */
export const inject = ['connection', 'apiProxy'] as const;
```

配套回归测试（`test/feedback.test.ts`）：

```ts
describe('plugin dependencies', () => {
  it('declares host services before feedback and RPC initialization read them', () => {
    expect(inject).toEqual(expect.arrayContaining(['connection', 'apiProxy']))
  })
})
```

## 验证

```bash
npm run verify   # typecheck + vitest(16 passed) + tsdown build ✅
```

修复后需重新构建 `lib/`（symlink 安装直接生效，无需重装）：
`~/.dsh/profiles/web/node_modules/dsh-dingo → myProject/dsh-dingo`。

## 配套：profile 侧安装配置（仓库外，`~/.dsh/profiles/web/`）

`cordis.patch.yml` 中 dingo 条目（远程域名访问需放开 authority）：

```yaml
# dsh-dingo（声音提醒）：域名访问（macdsh.zlxy.sd.cn）下 /dingo RPC 通道
# 需放开 loopback 权威（默认只信回环源，域名请求会被 authority 拒绝）。
- id: dsh-dingo
  config:
    channelAuthority: trusted-host
```

注意：该配置在用户主目录 profile 内，不在本仓库；本文档仅固化原因与内容。

## 时间线

| 时间 | 事件 |
|---|---|
| 22:55 | 初版提交 `0d0d975` |
| 22:58 | `link:` 安装进 web profile（bundles + symlink + patch）→ **DSH 起不来** |
| 23:00 | 补 `inject` 声明 + 回归测试，重建 `lib/` |
| 23:01 | profile `cordis.yml` 重新生成，启动恢复正常 |
