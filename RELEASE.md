# 51job-cli 发版指南

## 前置条件

当前项目目录 **不是 git 仓库**（2026-08-25 状态）。CI 工作流需要关联 GitHub 仓库，请先完成初始化。

## 首次发布准备

```bash
# 进入项目目录
cd C:\Users\A\Desktop\project\51job-cli

# 1. 初始化仓库
git init
git add .
git commit -m "feat: P2 完成（可用性校验、OCR、CI、站点分析技能）"

# 2. 在 GitHub 创建仓库（二选一）
# 方式 A：使用 GitHub CLI（推荐）
gh repo create 51job-cli --public --source=. --push

# 方式 B：手动在网页创建后
# git remote add origin https://github.com/<你的账号>/51job-cli.git
# git push -u origin main

# 3. 配置 NPM_TOKEN secret
# 在 GitHub 仓库 Settings -> Secrets and variables -> Actions -> New repository secret
# 名称：NPM_TOKEN
# 值：npm 账户的 publish token（https://www.npmjs.com/settings/<你的账号>/tokens）
```

## 版本发布流程

1. 在 `package.json` 更新 `version`（如 `0.1.0` -> `0.2.0`）。
2. 提交并推送：

```bash
git add package.json
git commit -m "chore: bump v0.2.0"
git push
```

3. 打 tag 并推送：

```bash
git tag v0.2.0
git push origin v0.2.0
```

4. GitHub Actions 自动执行：
   - `npm ci`
   - `npm run build`
   - `npm version --no-git-tag-version`
   - `npm publish --access public`
   - 自动创建 GitHub Release

## 手动触发

进入仓库 Actions -> tag-publish -> Run workflow，可填写目标 version。

## 包名

当前 `package.json` 中 `name` 为 `51job-cli`，经 `npm view` 验证尚未被占用。
如需改成 scoped 包（如 `@viyzhu/51job-cli`），请同步修改 `package.json` 的 `name`
并在发布命令中调整 `--access public`（默认 scoped 包为 private）。

## 安全

- 不要把 `NPM_TOKEN` 写入代码或 logs。
- CI 在 `NPM_TOKEN` 缺失时会安全跳过 publish，不会报错中断。
