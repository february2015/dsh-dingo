# 发布备忘（GitHub + NPM）

> 2026-08-15 首次发布：`dsh-dingo@0.1.0`。
> 本文档记录完整发布流程与踩坑，方便后续发版直接照做。

## 发版流程

```bash
# 1. 本地验证
npm run verify          # typecheck + vitest + build（publish 前 prepublishOnly 也会跑）

# 2. 提交并推送 GitHub
git add -A && git commit -m "…"
git push origin main

# 3. 升版本（patch/minor/major）
npm version patch       # 自动改 package.json + git tag

# 4. 发布 NPM（注意：DSH 沙箱内需指定可写缓存，见下）
npm_config_cache="$PWD/.npm-cache" npm publish
rm -rf .npm-cache       # 发布后清理临时缓存

# 5. 验证
npm view dsh-dingo version   # 应显示新版本（刚发布有短暂传播延迟，重试即可）
```

## ⚠️ DSH 沙箱踩坑：npm EPERM 与"root-owned files"

- **症状**：在 DSH 会话（bash 工具）里跑 `npm whoami` / `npm publish`，
  报 `EPERM open ~/.npm/_cacache/tmp/…`，提示"Your cache folder contains
  root-owned files, run: sudo chown -R …"。
- **真相**：`~/.npm` 所有权完全正常（无 root 文件），
  **不需要 chown**。这是 DSH 文件沙箱（workspace-write 模式）拦截了
  HOME 目录写入，npm 把 EPERM 误诊成 root 所有权问题。
- **绕行**：把 npm 缓存指到工作区内（可写）：
  `npm_config_cache="$PWD/.npm-cache" npm <cmd>`，发布后删掉该目录。
- **沙箱外**（用户自己的终端）：npm 一切正常，无此问题。

## 包信息

- npm 包名：`dsh-dingo`（registry.npmjs.org，登录账号 robinwlive）
- GitHub：https://github.com/february2015/dsh-dingo
- 打包内容（`files` 字段）：`lib/`（构建产物 + 类型）、`cordis.patch.yml`、
  `README.md`（英文默认）、`README.zh.md`（中文）、`LICENSE`；`prepack` 自动跑 `build` 重建 `lib/`。
- 安装：`dsh plugin --profile web add dsh-dingo`（`web` 为本机 profile 名）
