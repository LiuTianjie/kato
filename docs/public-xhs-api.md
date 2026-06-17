# 小红书业务 REST API

公共业务 API 挂在本地 dashboard 服务下：

```text
http://localhost:4173/api/v1/xhs/*
```

生产部署默认地址：

```text
https://kato.itool.tech/api/v1/xhs/*
```

这些接口面向本地或内网自动化调用。noVNC 浏览器接管、Cookie 同步、推流、点击输入仍是 dashboard 内部能力，不作为公共契约；CDP 只作为容器内部控制通道。

## 鉴权

启动 dashboard 前设置：

```bash
export KATO_API_TOKEN=change-me
npm run dashboard
```

请求必须携带其中一种：

```bash
Authorization: Bearer change-me
X-API-Key: change-me
```

未携带 token 返回 `401`；token 不正确返回 `403`。如果服务端未设置 `KATO_API_TOKEN`，会使用部署脚本默认 token `LiuTao0.1`。旧环境里的 `XHS_API_TOKEN` 仍作为兼容别名被接受，但新部署和 ServerX 对接都应使用 `KATO_API_TOKEN`。

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
curl -H "X-API-Key: $KATO_API_TOKEN" \
  http://localhost:4173/api/v1/xhs/health
```

### GET /api/v1/xhs/auth/status

返回 XHS service 当前登录状态。

```bash
curl -H "X-API-Key: $KATO_API_TOKEN" \
  http://localhost:4173/api/v1/xhs/auth/status
```

### POST /api/v1/xhs/posts/search

只搜索帖子，不入队。

```bash
curl -X POST http://localhost:4173/api/v1/xhs/posts/search \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $KATO_API_TOKEN" \
  -d '{"keywords":["AI工具","效率工具"],"limit":20}'
```

### POST /api/v1/xhs/posts/detail

读取单条帖子详情。

```bash
curl -X POST http://localhost:4173/api/v1/xhs/posts/detail \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $KATO_API_TOKEN" \
  -d '{"id":"笔记ID","url":"https://www.xiaohongshu.com/explore/笔记ID","xsecToken":"搜索结果中的 token"}'
```

### POST /api/v1/xhs/notes/sync

同步当前登录账号的我的笔记。

```bash
curl -X POST http://localhost:4173/api/v1/xhs/notes/sync \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $KATO_API_TOKEN" \
  -d '{"limit":30}'
```

### POST /api/v1/xhs/comments/draft

生成评论草稿，不发布。

```bash
curl -X POST http://localhost:4173/api/v1/xhs/comments/draft \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $KATO_API_TOKEN" \
  -d '{"post":{"id":"笔记ID","url":"https://www.xiaohongshu.com/explore/笔记ID","title":"标题","snippet":"内容摘要"},"keywords":["AI工具"]}'
```

### POST /api/v1/xhs/comments/publish

发布评论。必须显式确认并提供幂等键。

```bash
curl -X POST http://localhost:4173/api/v1/xhs/comments/publish \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $KATO_API_TOKEN" \
  -d '{"post":{"id":"笔记ID","url":"https://www.xiaohongshu.com/explore/笔记ID","xsecToken":"搜索结果中的 token"},"content":"确认发布的评论","confirm":true,"idempotencyKey":"publish-20260612-001"}'
```

### POST /api/v1/xhs/posts/like

点赞帖子。必须显式确认并提供幂等键。

```bash
curl -X POST http://localhost:4173/api/v1/xhs/posts/like \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $KATO_API_TOKEN" \
  -d '{"post":{"id":"笔记ID","url":"https://www.xiaohongshu.com/explore/笔记ID","xsecToken":"搜索结果中的 token"},"confirm":true,"idempotencyKey":"like-20260612-001"}'
```

## Serverx 舆情采集兼容接口

这些接口用于让 `serverx` 直接接入 Kato，替换 TikHub 小红书采集。它们同样要求 `KATO_API_TOKEN`，并返回 `serverx` 舆情模块可直接归一化的字段。

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
  -H "X-API-Key: $KATO_API_TOKEN" \
  -d '{"keyword":"提分侠","limit":20,"max_comments":20}'
```

### POST /note_detail

读取指定笔记详情，并尽力携带评论列表。

```bash
curl -X POST https://kato.itool.tech/note_detail \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $KATO_API_TOKEN" \
  -d '{"note_id":"笔记ID","url":"https://www.xiaohongshu.com/explore/笔记ID","xsec_token":"搜索结果中的 token","max_comments":50}'
```

### POST /note_comments

单独读取指定笔记评论。

```bash
curl -X POST https://kato.itool.tech/note_comments \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $KATO_API_TOKEN" \
  -d '{"note_id":"笔记ID","url":"https://www.xiaohongshu.com/explore/笔记ID","xsec_token":"搜索结果中的 token","limit":50}'
```

`note_sub_comments` 用于 `serverx` 的子评论接口契约。Kato 会尽力从页面中识别已展开的父子评论关系；页面无法识别父子关系时，会按当前可见评论做分页切片返回。

## TikHub 路径兼容

Kato 也支持 `serverx` 原 TikHub 小红书 App V2 路径，方便按官方文档参数调用。返回仍使用 Kato envelope：`{ "success": true, "data": ... }`。

```text
GET /api/v1/xiaohongshu/app_v2/search_notes
GET /api/v1/xiaohongshu/app_v2/get_image_note_detail
GET /api/v1/xiaohongshu/app_v2/get_video_note_detail
GET /api/v1/xiaohongshu/app_v2/get_note_comments
GET /api/v1/xiaohongshu/app_v2/get_note_sub_comments
```

分页参数支持：

| 用途 | 支持参数 | 说明 |
| --- | --- | --- |
| 搜索笔记 | `keyword`, `page`, `sort_type`, `note_type`, `time_filter`, `search_id`, `search_session_id` | `page` 会用于翻页；筛选参数会被接收并回显。Kato 当前基于浏览器页面搜索，无法保证与 TikHub App V2 排序完全一致。 |
| 图文/视频详情 | `note_id`, `share_text` | 两个详情路径映射到同一套 Kato 笔记详情读取能力。 |
| 一级评论 | `note_id`, `share_text`, `cursor`, `index`, `pageArea`, `sort_strategy` | `index`/`cursor=offset:N` 用于翻页，响应返回下一页 `cursor.index` 和 `cursor.cursor`。 |
| 二级评论 | `note_id`, `share_text`, `comment_id`, `cursor`, `index` | 会优先返回已识别父评论下的回复；页面无法识别父子关系时返回当前可见评论切片。 |

Kato 的分页是浏览器页面滚动后的 offset 分页，不是 TikHub App V2 的原生后端游标；对 `serverx` 舆情扫描足够用，但如果后续需要严格复刻 TikHub 的全量游标语义，需要再补基于小红书内部接口的网络响应解析。

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
