# 小红书 MCP 适配契约

`xhs.config.local.json` 中的 `mcp.tools` 用来映射真实 MCP 工具名。工具返回值可以是 MCP text content 中的 JSON，也可以直接返回 JSON 对象。

## Kato XHS browser service

本项目内置自有 XHS browser service。dashboard 主路径使用 REST API，MCP 只作为给 agent/MCP 客户端使用的兼容层。MCP 服务默认是 Streamable HTTP 风格的 JSON-RPC over HTTP：

```text
http://localhost:18060/mcp
```

本项目推荐配置：

```json
{
  "provider": "http",
  "mcp": {
    "url": "http://localhost:18060/mcp",
    "tools": {
      "searchPosts": "search_feeds",
      "getPost": "get_feed_detail",
      "publishComment": "post_comment_to_feed"
    }
  }
}
```

搜索读取使用同一服务的 REST `GET /api/v1/feeds/search?keyword=AI工具`，返回结构是 `data.feeds`，其中包含评论发布需要的 `id` 和 `xsecToken`。

`post_comment_to_feed` 入参会使用搜索结果中保存的 `id` 和 `xsecToken`：

```json
{
  "feed_id": "笔记ID",
  "xsec_token": "搜索结果里的 xsecToken",
  "content": "已审核评论草稿"
}
```

## 必需工具

### searchPosts

输入：

```json
{ "query": "AI工具", "limit": 30 }
```

输出数组字段：

```json
[
  {
    "id": "post-id",
    "url": "https://www.xiaohongshu.com/explore/...",
    "title": "帖子标题",
    "snippet": "摘要或正文片段",
    "author": "作者",
    "likeCount": 100,
    "commentCount": 20,
    "publishedAt": "2026-05-10T08:30:00+08:00"
  }
]
```

适配层会把 `data.feeds[]` 或 MCP text content 中的 JSON 规范化为上述字段。

### getPost

输入：

```json
{ "idOrUrl": "https://www.xiaohongshu.com/explore/...", "url": "https://www.xiaohongshu.com/explore/..." }
```

输出单条帖子对象，字段同上。

### openPost

输入：

```json
{ "url": "https://www.xiaohongshu.com/explore/..." }
```

用于打开帖子页面，等待用户人工确认。

## 可选工具

### prefillComment

输入：

```json
{
  "url": "https://www.xiaohongshu.com/explore/...",
  "comment": "评论草稿"
}
```

只允许把草稿填入评论框，不允许发布。

### publishComment

输入：

```json
{
  "feed_id": "笔记ID",
  "xsec_token": "搜索结果里的 xsecToken",
  "content": "评论草稿"
}
```

仅在用户显式运行 `npm run publish -- --interaction-id <id>` 或 `--ids 1,2,3` 后调用。dashboard 默认会优先走 REST `POST /api/v1/feeds/comment`；MCP tool 是给外部 agent 的兼容入口。

## 禁用能力

不要在 MCP 配置里接入自动点赞、验证码绕过或风控规避工具。手动任务只负责生成草稿队列；发布评论必须由用户显式指定互动 ID 后触发。
