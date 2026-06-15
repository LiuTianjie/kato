# 小红书业务 REST API

公共业务 API 挂在本地 dashboard 服务下：

```text
http://localhost:4173/api/v1/xhs/*
```

生产部署默认地址：

```text
https://kato.itool.tech/api/v1/xhs/*
```

这些接口面向本地或内网自动化调用。CDP 浏览器接管、推流、点击输入仍是 dashboard 内部能力，不作为公共契约。

## 鉴权

启动 dashboard 前设置：

```bash
export XHS_API_TOKEN=change-me
npm run dashboard
```

请求必须携带其中一种：

```bash
Authorization: Bearer change-me
X-API-Key: change-me
```

未携带 token 返回 `401`；token 不正确返回 `403`。如果服务端未设置 `XHS_API_TOKEN`，会使用部署脚本默认 token `LiuTao0.1`。

## 响应格式

成功：

```json
{ "success": true, "data": {} }
```

失败：

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "错误说明"
  }
}
```

## 接口

### GET /api/v1/xhs/health

返回本地服务、XHS service 健康和登录态摘要。

```bash
curl -H "X-API-Key: $XHS_API_TOKEN" \
  http://localhost:4173/api/v1/xhs/health
```

### GET /api/v1/xhs/auth/status

返回 XHS service 当前登录状态。

```bash
curl -H "X-API-Key: $XHS_API_TOKEN" \
  http://localhost:4173/api/v1/xhs/auth/status
```

### POST /api/v1/xhs/posts/search

只搜索帖子，不入队。

```bash
curl -X POST http://localhost:4173/api/v1/xhs/posts/search \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $XHS_API_TOKEN" \
  -d '{"keywords":["AI工具","效率工具"],"limit":20}'
```

### POST /api/v1/xhs/posts/detail

读取单条帖子详情。

```bash
curl -X POST http://localhost:4173/api/v1/xhs/posts/detail \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $XHS_API_TOKEN" \
  -d '{"id":"笔记ID","url":"https://www.xiaohongshu.com/explore/笔记ID","xsecToken":"搜索结果中的 token"}'
```

### POST /api/v1/xhs/notes/sync

同步当前登录账号的我的笔记。

```bash
curl -X POST http://localhost:4173/api/v1/xhs/notes/sync \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $XHS_API_TOKEN" \
  -d '{"limit":30}'
```

### POST /api/v1/xhs/comments/draft

生成评论草稿，不发布。

```bash
curl -X POST http://localhost:4173/api/v1/xhs/comments/draft \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $XHS_API_TOKEN" \
  -d '{"post":{"id":"笔记ID","url":"https://www.xiaohongshu.com/explore/笔记ID","title":"标题","snippet":"内容摘要"},"keywords":["AI工具"]}'
```

### POST /api/v1/xhs/comments/publish

发布评论。必须显式确认并提供幂等键。

```bash
curl -X POST http://localhost:4173/api/v1/xhs/comments/publish \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $XHS_API_TOKEN" \
  -d '{"post":{"id":"笔记ID","url":"https://www.xiaohongshu.com/explore/笔记ID","xsecToken":"搜索结果中的 token"},"content":"确认发布的评论","confirm":true,"idempotencyKey":"publish-20260612-001"}'
```

### POST /api/v1/xhs/posts/like

点赞帖子。必须显式确认并提供幂等键。

```bash
curl -X POST http://localhost:4173/api/v1/xhs/posts/like \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $XHS_API_TOKEN" \
  -d '{"post":{"id":"笔记ID","url":"https://www.xiaohongshu.com/explore/笔记ID","xsecToken":"搜索结果中的 token"},"confirm":true,"idempotencyKey":"like-20260612-001"}'
```

## Serverx 舆情采集兼容接口

这些接口用于让 `serverx` 直接接入 Kato，替换 TikHub 小红书采集。它们同样要求 `XHS_API_TOKEN`，并返回 `serverx` 舆情模块可直接归一化的字段。

根路径和 namespaced 路径都可用：

```text
POST /search_notes
POST /note_detail
POST /note_comments
POST /note_sub_comments

POST /api/v1/xhs/serverx/search_notes
POST /api/v1/xhs/serverx/note_detail
POST /api/v1/xhs/serverx/note_comments
POST /api/v1/xhs/serverx/note_sub_comments
```

生产环境推荐把 `serverx` 的小红书采集 base URL 指向：

```text
https://kato.itool.tech
```

### POST /search_notes

按关键词搜索笔记，并尽力携带评论列表。

```bash
curl -X POST https://kato.itool.tech/search_notes \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $XHS_API_TOKEN" \
  -d '{"keyword":"提分侠","limit":20,"max_comments":20}'
```

### POST /note_detail

读取指定笔记详情，并尽力携带评论列表。

```bash
curl -X POST https://kato.itool.tech/note_detail \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $XHS_API_TOKEN" \
  -d '{"note_id":"笔记ID","url":"https://www.xiaohongshu.com/explore/笔记ID","xsec_token":"搜索结果中的 token","max_comments":50}'
```

### POST /note_comments

单独读取指定笔记评论。

```bash
curl -X POST https://kato.itool.tech/note_comments \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $XHS_API_TOKEN" \
  -d '{"note_id":"笔记ID","url":"https://www.xiaohongshu.com/explore/笔记ID","xsec_token":"搜索结果中的 token","limit":50}'
```

`note_sub_comments` 预留给 `serverx` 的子评论接口契约；当前返回空数组。Kato 会在抓取一级评论时尽力从页面中识别已展开的父子评论关系。

## 幂等语义

`comments/publish` 和 `posts/like` 必须传 `idempotencyKey`。同一进程内重复提交同一个 key，会返回第一次调用的结果，不会重复调用 XHS service 发布或点赞。

## 常见错误码

- `UNAUTHORIZED`: 未携带 token。
- `FORBIDDEN`: token 不正确。
- `POST_IDENTIFIER_REQUIRED`: 缺少 `post.id` 或 `post.url`。
- `CONFIRM_REQUIRED`: 发布/点赞缺少 `confirm:true`。
- `IDEMPOTENCY_KEY_REQUIRED`: 发布/点赞缺少 `idempotencyKey`。
- `XSEC_TOKEN_REQUIRED`: 发布/点赞缺少 `post.xsecToken`。
- `MCP_ERROR`: XHS service 或兼容 MCP HTTP 调用失败。
