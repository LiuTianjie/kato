# Kato

半自动小红书运营工作台：发现 AI/效率工具相关帖子，快速入队，然后在本地看板里由你筛选、生成评论并确认发布点赞。

现在默认不启用定时任务。你从操作面板手动发起搜索入队；只有你选中队列项并点击“评论并发布”时，才会调用容器服务的发布接口。

## 快速开始

推荐直接用一个容器跑完整 Kato：dashboard、多平台 Browser Runtime、XHS/Douyin service 和可选 MCP 兼容层都在同一个镜像里。

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
Douyin service REST: http://localhost:18070/api/v1/*
```

Chrome、CDP、VNC/noVNC 和平台 worker runtime 都只在容器内部监听。浏览器画面从 dashboard 的“浏览器接管”页进入，不需要也不应该暴露调试端口。

如果要本地 Node 开发，再使用：

```bash
npm install
cp .env.example .env
npm run init-db
npm run dashboard
```

打开看板后，先在“我的笔记库”录入你的真实小红书笔记，再手动发起搜索入队。队列里不合适的帖子直接跳过；合适的帖子可批量“评论并发布”。运行结果会输出到 `output/runs/`，包含 Markdown 和 CSV 两份队列。

## 容器内 Browser Runtime 与平台 Service

Kato 内置通用 Browser Runtime，负责启动容器内 Google Chrome、Xvfb、noVNC、内部 CDP、健康检查和重启恢复。小红书、抖音等平台 service 只负责平台数据解析、登录态同步、搜索、详情、评论和分页。它们和 dashboard 在同一个镜像、同一个容器里：

```bash
docker compose up -d --build
```

Kato 镜像只支持 AMD64；本地和服务器都使用 `linux/amd64`：

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
http://localhost:18070/api/v1/*
```

本地 Node 开发时创建配置：

```bash
cp xhs.config.example.json xhs.config.local.json
```

小红书 MCP 兼容层会映射这些工具：

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

## noVNC 浏览器接管与登录态同步

如果小红书或抖音需要扫码登录、二次验证或人工确认，可以在 dashboard 里打开对应平台的 noVNC 画面。noVNC 是远程桌面画面，不向网页暴露公网 CDP：

```bash
docker compose up -d --build
```

推荐流程：

1. 打开 dashboard 的“浏览器接管”页。
2. 选择“小红书登录”或“抖音登录”，Kato 会打开该平台的 viewer runtime。
3. 在 noVNC 画面里扫码或完成验证。
4. 登录成功后，点击对应平台的“同步 Cookie”。

viewer runtime 只给人登录和观察页面用；worker runtime 只给接口任务使用。两者不共享 Chrome profile，登录态会通过“同步 Cookie”从 viewer 导出并注入/持久化到 worker，避免人工操作把正在跑的接口任务导航走。

小红书登录态会保存到：

```text
mcp/xiaohongshu/data/cookies.json
/app/data/platforms/xhs/cookies.json
```

抖音登录态会保存到：

```text
/app/data/platforms/douyin/cookies.json
```

容器内 Chrome 默认通过 Xvfb 以有头模式运行，减少 headless 浏览器特征。只有显式设置 `XHS_CHROMIUM_HEADLESS=1` 时才会退回 headless。

旧命令名仍保留兼容，但它现在只是打开 dashboard/noVNC 登录入口，不再建议按 CDP 接管理解：

常用参数：

```bash
npm run auth:cdp
npm run auth:cdp -- --wait
npm run auth:cdp -- --wait --sync-cookies
npm run auth:cdp -- --restart
npm run auth:sync-cookies
```

如果已经在 noVNC 里完成登录，需要手动再同步一次小红书 Cookie，可以运行：

```bash
npm run auth:sync-cookies
```

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

## AMD64 镜像与 Browser Runtime

Kato 镜像只发布 `linux/amd64`。仓库内置一个可复用的 `browser-runtime` 镜像 target，负责 `google-chrome-stable`、Xvfb、x11vnc、noVNC、websockify、xdotool、内部 CDP、健康检查、lease 和重启恢复。最终 `kato` 镜像基于这个 runtime 构建，小红书和抖音是第一批平台 adapter。后续接 B 站时按 [docs/platform-adapters.md](docs/platform-adapters.md) 的分层接入。

默认 runtime slot：

| Slot | 用途 | Runtime | CDP | noVNC |
| --- | --- | ---: | ---: | ---: |
| `xhs-viewer` | 小红书人工登录/观察 | `18100` | `9224` | `6080` |
| `xhs-worker` | 小红书接口任务 | `18101` | `9225` | 关闭 |
| `douyin-viewer` | 抖音人工登录/观察 | `18110` | `9234` | `6090` |
| `douyin-worker` | 抖音接口任务 | `18111` | `9235` | 关闭 |

B 站 viewer/worker slot 已预留配置，但默认不启动业务 service。所有 runtime、CDP、VNC/noVNC 端口都只在容器内部使用；Luma 和生产环境只暴露 dashboard `4173`。平台 service 执行浏览器任务前会获取本平台 worker lease，任务结束、取消或超时后释放，避免多个任务互相重启或导航同一个 Chrome。

单独构建基础 runtime：

```bash
docker buildx build \
  --platform linux/amd64 \
  --target browser-runtime \
  -f Dockerfile \
  -t ghcr.io/your-org/kato-browser-runtime:latest \
  .
```

如需手动发布镜像：

```bash
docker buildx build \
  --platform linux/amd64 \
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

部署配置见 [deploy/kato.luma.yml](deploy/kato.luma.yml)。它只对外暴露 dashboard 的 `4173` 端口；XHS service、Douyin service、Browser Runtime、CDP、VNC/noVNC 都保持容器内部能力，不直接暴露到公网。当前 manifest 给多 runtime 场景预留了较高内存，默认 limit 为 8G、reservation 为 6G。

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
- 打开小红书/抖音 noVNC 登录页并同步 Cookie 到对应 worker
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
