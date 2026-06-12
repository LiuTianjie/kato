# 开源前检查

这个仓库会在本地生成运营数据、浏览器登录态和运行输出。开源前建议按下面清单检查一次。

## 不应提交

- `.env`、`.env.*`，除了 `.env.example`。
- `xhs.config.local.json`。
- `data/`，包含 SQLite 数据库和用户笔记。
- `output/`，包含运行队列、帖子 URL、`xsec_token` 等运行产物。
- `mcp/xiaohongshu/data/`，包含 cookies、debug 截图和浏览器运行态。
- `mcp/xiaohongshu/images/`，包含发布素材。
- `mcp/xiaohongshu/source/`，这是历史上本机拉取的第三方源码目录；开源发布和 Docker 构建都不需要它。

## 可以提交

- `xhs.config.example.json`。
- `Dockerfile`、`docker-compose*.yml`、`.github/workflows/release.yml`。
- `mcp/xiaohongshu/docker-compose*.yml` 兼容入口。
- `site/` GitHub Pages 介绍页。
- `mcp/xiaohongshu/README.md`。
- `docs/`、`src/`、`public/`、`tests/`。

## 许可证

本项目自己的代码可以单独选择许可证，例如 MIT 或 Apache-2.0。历史第三方目录 `mcp/xiaohongshu/source/` 不应提交，也不应被纳入本项目许可证范围。

## 本地自检命令

```bash
rg -n "(/Users/|web_session|id_token|xsec_token=|Authorization: Bearer|XHS_API_TOKEN=.+[^e]$)" \
  -g '!node_modules' \
  -g '!dist' \
  -g '!data' \
  -g '!output' \
  -g '!mcp/xiaohongshu/source' \
  -g '!mcp/xiaohongshu/data'
```

如果需要对外发布 Docker 镜像，确认镜像构建上下文没有包含 cookies、SQLite、输出队列或未授权的上游源码。
