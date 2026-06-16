# Kato XHS browser service

本目录保留 Kato 内置 XHS browser service 的代码和兼容 Compose 入口。正式部署使用根目录单镜像：dashboard、多平台 browser-runtime、REST API、内部 CDP 和可选 MCP 兼容层都在同一个 `kato` 容器里。

底层 Chrome、Xvfb、noVNC、worker lease 和重启恢复由通用 `browser-runtime` 负责；本目录的 XHS service 只负责小红书搜索、详情、评论、登录态同步和平台数据解析。

```bash
cd ../..
docker compose up -d --build
docker compose logs -f
```

MCP 地址：

```text
http://localhost:18060/mcp
```

REST 地址：

```text
http://localhost:18060/api/v1/*
```

小红书现在使用独立 runtime：

```text
xhs-viewer: 人工登录/noVNC/扫码
xhs-worker: 搜索、详情、评论等接口任务
```

两个 runtime 不共享 Chrome profile。完成 noVNC 登录后，需要在 dashboard 里点击“小红书同步 Cookie”，或运行根目录的 `npm run auth:sync-cookies`，把 viewer Cookie 导出并注入 worker。

登录态会保存在：

```text
mcp/xiaohongshu/data/cookies.json
/app/data/platforms/xhs/cookies.json
```

本目录不需要 `source/`。历史上如果本机存在 `mcp/xiaohongshu/source/`，它会被 `.gitignore` 和 `.dockerignore` 排除，不参与开源发布和镜像构建。
