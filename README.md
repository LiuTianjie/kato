# Kato

半自动小红书运营工作台：发现 AI/效率工具相关帖子，快速入队，然后在本地看板里由你筛选、生成评论并确认发布点赞。

现在默认不启用定时任务。你从操作面板手动发起搜索入队；只有你选中队列项并点击“评论并发布”时，才会调用容器服务的发布接口。

## 快速开始

推荐直接用一个容器跑完整 Kato：dashboard、容器内 Chromium、CDP、XHS browser service 和可选 MCP 兼容层都在同一个镜像里。

```bash
cp .env.example .env
docker compose up -d --build
```

打开：

```text
http://localhost:4173
```

容器会同时暴露：

```text
Dashboard: http://localhost:4173
XHS service REST: http://localhost:18060/api/v1/*
XHS service MCP: http://localhost:18060/mcp
CDP: http://127.0.0.1:9222/json
```

如果要本地 Node 开发，再使用：

```bash
npm install
cp .env.example .env
npm run init-db
npm run dashboard
```

打开看板后，先在“我的笔记库”录入你的真实小红书笔记，再手动发起搜索入队。队列里不合适的帖子直接跳过；合适的帖子可批量“评论并发布”。运行结果会输出到 `output/runs/`，包含 Markdown 和 CSV 两份队列。

## 容器内 XHS browser service

Kato 内置自有的 XHS browser service，负责启动容器内 Chromium、暴露本机 CDP、提供 REST API，并保留一个轻量 `/mcp` 兼容层给 agent/MCP 客户端使用。它和 dashboard 在同一个镜像、同一个容器里：

```bash
docker compose up -d --build
```

Apple Silicon / ARM64 可以显式指定平台：

```bash
docker compose -f docker-compose.yml -f docker-compose.arm64.yml up -d --build
```

AMD64 服务器可以显式指定平台：

```bash
docker compose -f docker-compose.yml -f docker-compose.amd64.yml up -d --build
```

服务默认地址是：

```text
http://localhost:18060/mcp
```

同一个容器也提供 REST API：

```text
http://localhost:18060/api/v1/*
```

本地 Node 开发时创建配置：

```bash
cp xhs.config.example.json xhs.config.local.json
```

这个项目会映射这些工具：

- `search_feeds`
- `get_feed_detail`
- `post_comment_to_feed`

dashboard 主路径使用 REST：搜索走 `GET /api/v1/feeds/search`，详情走 `POST /api/v1/feeds/detail`，评论发布走 `POST /api/v1/feeds/comment`，点赞走 `POST /api/v1/feeds/like`。`/mcp` 是兼容层，方便 agent/MCP 客户端调用同样能力。

评论发布只会在你从看板确认“评论并发布”，或显式运行 `npm run publish -- --interaction-id <id>` / `--ids 1,2,3` 后调用。不会调用收藏、验证码绕过等能力。

[autoclaw-cc/xiaohongshu-mcp-skills](https://github.com/autoclaw-cc/xiaohongshu-mcp-skills) 已作为交互契约参考：评论/互动必须先展示内容并等待用户确认，发布所需字段是 `feed_id`、`xsec_token`、`content`。

如果接入其他 MCP，可以从 `xhs.config.example.json` 开始，改成 `stdio` 或 `http` provider 并填写工具名。

> 开源说明：本仓库不再依赖无明确许可证的第三方 MCP 源码。`.gitignore` 和 `.dockerignore` 默认排除 cookies、素材、SQLite、运行输出以及历史 `mcp/xiaohongshu/source/` 目录。准备公开仓库前建议再走一遍 [docs/open-source-readiness.md](docs/open-source-readiness.md)。

## 常用命令

```bash
npm run dashboard
npm run run -- --slot manual --limit 30
npm run auth:cdp
npm run notes:import -- data/notes.csv
npm run publish -- --interaction-id 1
npm run mark -- --interaction-id 1 --status posted_by_user
npm test
```

## 容器 CDP 浏览器接管

如果小红书登录被二次验证、扫码安全确认或页面验证拦住，可以让 Kato 容器里的 Chromium 暴露 CDP，再由人通过 CDP/DevTools 接管：

```bash
docker compose up -d --build
npm run auth:cdp
```

Kato 容器会把浏览器 CDP 映射到本机：

```text
http://127.0.0.1:9222/json
```

容器内 Chromium 默认通过 Xvfb 以有头模式运行，减少 headless 浏览器特征。只有显式设置 `XHS_CHROMIUM_HEADLESS=1` 时才会退回 headless。

`npm run auth:cdp` 不会启动宿主机浏览器；它会请求 Kato 容器打开登录页，并等待容器内 Chromium 的 CDP 端口就绪。你在看板“浏览器接管”Tab 里扫码/完成验证后，登录态会保存到 `mcp/xiaohongshu/data/cookies.json`。

常用参数：

```bash
npm run auth:cdp -- --wait
npm run auth:cdp -- --wait --sync-cookies
npm run auth:cdp -- --restart
npm run auth:sync-cookies
```

如果是通过 CDP 手动操作完成登录，登录等待流程通常会自动保存 cookies。需要手动从容器 CDP 再导出一次时，运行：

```bash
npm run auth:sync-cookies
```

也可以在看板左侧“账号 / MCP”里点“打开浏览器接管”，完成验证后按需点“同步 CDP 登录态”。CDP 端口只绑定本机，不要把 `9222` 暴露到公网。

## 标准业务 REST API

dashboard 额外提供稳定业务 API：

```text
http://localhost:4173/api/v1/xhs/*
```

启动前设置本地 API token：

```bash
export XHS_API_TOKEN=change-me
npm run dashboard
```

调用示例：

```bash
curl -X POST http://localhost:4173/api/v1/xhs/posts/search \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $XHS_API_TOKEN" \
  -d '{"keywords":["AI工具"],"limit":10}'
```

接口覆盖登录状态、帖子搜索、详情、我的笔记同步、评论草稿、评论发布和点赞。发布/点赞必须传 `confirm:true` 和 `idempotencyKey`，重复 key 不会重复调用 XHS service。完整契约见 [docs/public-xhs-api.md](docs/public-xhs-api.md)。

## 多架构镜像

Kato 单镜像支持 `linux/arm64` 和 `linux/amd64`：

- `docker-compose.arm64.yml` 使用 Debian Chromium，适合 Apple Silicon / ARM64。
- `docker-compose.amd64.yml` 同样使用 Debian Chromium，适合 AMD64 Linux 服务器。
- 两个架构都安装中文字体、生成 `zh_CN.UTF-8` locale，并暴露本机 CDP `127.0.0.1:9222`。

如需发布单 tag 多架构镜像：

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f Dockerfile \
  -t ghcr.io/your-org/kato:latest \
  --push \
  .
```

## Luma 部署

仓库内置 Luma single-service manifest，默认部署到 `home` region 的 `lab` 节点，并通过 `kato.itool.tech` 访问：

```bash
ARK_API_KEY_VALUE=your-ark-api-key \
ARK_MODEL_VALUE=your-ark-model-or-endpoint \
./scripts/deploy-luma.sh
```

脚本会写入 `XHS_API_TOKEN` secret，默认值是 `LiuTao0.1`。生产评论生成还需要 Luma secret `ARK_API_KEY` 和 `ARK_MODEL`；第一次部署可以通过上面的环境变量写入，后续如果 secret 已存在，直接运行脚本即可。

需要覆盖 REST API token 时：

```bash
XHS_API_TOKEN_VALUE=your-token ./scripts/deploy-luma.sh
```

只做校验和 dry-run：

```bash
DRY_RUN=1 ./scripts/deploy-luma.sh
```

部署配置见 [deploy/kato.luma.yml](deploy/kato.luma.yml)。它只对外暴露 dashboard 的 `4173` 端口；XHS service 和 CDP 保持容器内部能力，不直接暴露到公网。

## 操作面板

启动本地看板：

```bash
npm run dashboard
```

打开：

```text
http://localhost:4173
```

面板支持：

- 查看 XHS service 登录状态并打开容器内浏览器接管
- 管理你的笔记库：标题、链接、摘要、关键词、适合场景、启用/停用
- 手动搜索帖子入队，不立即消耗 LLM 生成评论
- 队列全选或单选后批量评论并发布
- 查看互动队列、跳过不合适帖子、批量评论并发布
- 查看每条发布任务的当前步骤：读取详情、生成评论、发布评论、点赞、完成
- 查看历史 Run、状态分布、关键词、发布率和评论/互动统计

## 本地 Agent 流程

运行时不依赖 Codex。`npm run dashboard` 启动的是本地 Node 后端，它内部的 growth agent 会执行：

1. 读取你的 active 笔记库。
2. 按关键词调用 XHS browser service 搜索帖子。
3. 去重并直接写入 `new` 队列，不做前置相关性筛选。
4. 你跳过不合适的帖子，选中合适帖子后点击“评论并发布”。
5. 每个帖子作为独立任务并发执行：读取详情、生成评论、发布评论、点赞、写入历史。

没有 active 笔记时，agent 会拒绝生成队列，避免后续产出无法关联你内容的泛泛评论。

## 测试

```bash
npm test
npm run build
```

测试覆盖笔记库管理、本地 agent 前置检查、笔记导入、搜索入队、去重、评论草稿长度、`posted_via_mcp` 发布状态，以及 XHS browser service 搜索响应结构解析。

## AI 评论生成

默认使用本地规则生成评论草稿，不需要外部 API。

生产部署默认要求使用火山方舟。评论草稿、批量评论发布会读取：

- `COMMENT_PROVIDER=ark`
- `ARK_API_KEY`
- `ARK_MODEL`

如需使用火山方舟：

```bash
export COMMENT_PROVIDER=ark
export ARK_API_KEY=你的火山方舟APIKey
export ARK_MODEL=你的方舟推理接入点或模型ID
export ARK_RELEVANCE_MODEL=doubao-seed-2-0-mini-260215
export ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
npm run dashboard
```

`ARK_RELEVANCE_MODEL`、`ARK_FAST_MODEL`、`CONTENT_MODEL` 都是可选项；不配置时会回落到 `ARK_MODEL`。

API Key 只在本地后端进程读取，不会传到前端页面。

搜索入队不再调用模型筛选；模型只在你选择评论并发布时调用。

## 笔记库 CSV

字段：

```csv
title,url,summary,keywords,scenarios,status
```

`keywords` 和 `scenarios` 使用 `|` 分隔。

## 状态

- `new`
- `drafted`
- `posted_by_user`
- `posted_via_mcp`
- `skipped`
