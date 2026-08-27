# 51job-cli

前程无忧（51job）招聘端自动化 CLI，基于 puppeteer-core / CDP（Chrome DevTools Protocol）驱动本机 Chrome。

- 候选人列表 / 未读（`list`）
- Hi聊发消息 / 打招呼（`greet` / `send`）
- 在线简历预览（`preview`）
- 人才搜索（`search`，13 维筛选）
- 人才望远镜推荐池（`recommend`）
- 定时任务：每日候选人人选自动筛查

## 安装

### 方式一：npm 全局安装（推荐）

```bash
npm install -g 51job-cli
```

### 方式二：从源码构建

```bash
git clone https://github.com/se7enfive/51job-cli.git
cd 51job-cli
npm install
npm run build
npm link            # 将 51job 命令挂到 PATH
```

## 使用

```bash
51job login          # 打开登录页
51job wait-login     # 等待扫码完成
51job list --unread --json
51job recommend <岗位> --json
51job search "<关键词>" --city 广州 --json
```

## 许可证

GPL-3.0