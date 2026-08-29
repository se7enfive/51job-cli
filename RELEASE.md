# 发布指引

本仓库已使用 GitHub Actions 构建自动发布流水线，确保每一次对外释放的版本都有确定的质量屏障和构建记录。

## 历史回溯

本仓库原计划的本地自动发布与重置功能，已随 T302 CI 工程化调整完整移入工作流控制台，**本地请不要直接通过 npm 工具链运行未经流水线审核授权的代码版本指令直接上包**！

## 新版本流转指南

如果你确信代码通过了 `npm run typecheck && npm test && npm run build`（本地 prePublish 会拦截），可以推送版本到云端发布。

### 方式一：发布带有历史版本的标签 (Tag Push Release - 推荐)

这是完整的包及历史源码生命管理最佳实践。

1. **刷新日志**：手动在 `CHANGELOG.md` 中填写当前版本的封版修改记录。
2. **打标签推栈**：在本地修改 `package.json` 中的 `version` 字段到想要的新版本号：
   ```bash
   git add package.json CHANGELOG.md ...
   git commit -m "chore: release vX.Y.Z"
   git tag "vX.Y.Z"
   git push origin main --tags
   ```

* 此时，基于 `tag-publish.yml`，系统流水线将在识别 `v*` 标准标签被推送后，自动发起完整的 build-test 任务校验。在一切全绿无误的前提下自动构建 `gh release create` 会话附带自动生成的提交差异。若 `package.json` 版本已与目标一致，会跳过 `npm version`（避免 `Version not changed` 中断 publish）。
* **关于 npm 发布（可选环节）**：默认跳过 npm 发布，GitHub Release 与 npm 完全解耦——未配置 `NPM_TOKEN` 时流水线自动跳过 npm 相关步骤（typecheck/test/build 与 Release 创建照常执行），不会红叉。若后续需要发布到 npm 官方源，在仓库 Secrets 添加 `NPM_TOKEN`（Automation 类型 token）后重推 tag 即可。

### 方式二：跳过发布标记的控制台直接推送 (Workflow Dispatch Override)

如果你只想重新触发 CI 走 npm publish 发布而不需要进行 Git 的历史打入标签：

1. 登录该项目的 GitHub 项目管理页 -> `Actions` -> 选取 `tag-publish` 栏目。
2. 展开旁边的 `Run workflow` 触发面板。
3. 可以在 `version` 输入框中填入你指定的正确包版本：例 `0.1.2` 或者带 prerelease 类型： `0.1.3-beta.1`。
   - 输入框已增加 SemVer 标准防呆校验。
   - 输入此项会无视在包里的原有标记号直接替换对应属性号压包，但它也**不会在代码层面建立 GitHub Tag 和历史节点（单纯走包分发下流）**。

## Q/A 环境阻断验证排查情况

* 若遇到了发版错误直接卡挂变红：
  1. 若 npm 发布步骤报权限/401 类错误：检查 GitHub Settings 中是否已配置 `NPM_TOKEN`（无 `NPM_TOKEN` 时 npm 步骤会整体跳过，属于预期行为，不影响 GitHub Release 生成）。
  2. 此环境工作流已剥开 `id-token` 等级缩小爆破面积，并排除了同时触发 `tags` 以及创建完 GitHub Session 所产生的冗余重发流（即所谓的第二次 publish）。如有遇到可再排查是否其他环境因素联动。
