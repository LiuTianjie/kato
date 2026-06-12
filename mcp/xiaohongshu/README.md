# Kato XHS browser service

本目录保留 Kato 内置 XHS browser service 的代码和兼容 Compose 入口。正式部署使用根目录单镜像：dashboard、容器内 Chromium、REST API、CDP 和可选 MCP 兼容层都在同一个 `kato` 容器里。

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

登录态会保存在：

```text
mcp/xiaohongshu/data/cookies.json
```

本目录不需要 `source/`。历史上如果本机存在 `mcp/xiaohongshu/source/`，它会被 `.gitignore` 和 `.dockerignore` 排除，不参与开源发布和镜像构建。
