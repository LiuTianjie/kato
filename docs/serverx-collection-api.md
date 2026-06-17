# ServerX 舆情采集兼容接口

这些接口用于让 `serverx` 舆情监控模块直接调用 Kato 采集抖音和 B站数据。Kato 只对外暴露 dashboard 端口，生产 base URL 通常是：

```text
https://kato.itool.tech
```

所有接口都需要共享 Kato token：

```bash
-H "Authorization: Bearer $KATO_API_TOKEN"
```

`KATO_API_TOKEN` 是小红书、抖音、B站和 Kato Console 共用的统一 token。旧名 `XHS_API_TOKEN` 仅保留为兼容别名。

成功返回：

```json
{ "code": 200, "message": "success", "data": {} }
```

失败返回：

```json
{ "code": 40001, "message": "invalid params", "data": null }
```

`serverx` 可把 `code` 为 `200` 视为成功。Cookie 失效或未登录时，Kato 会尽量返回 `40101`；平台要求人工验证时返回 `40102`。

## Cookie 和验证策略

抖音和 B站都不应该依赖匿名采集。匿名访问偶尔能拿到公开数据，但评论、详情或连续请求会更容易触发登录/风控。推荐流程：

1. 打开 Kato dashboard。
2. 进入“浏览器接管”。
3. 点击对应平台登录按钮：小红书、抖音、B站。
4. 在 noVNC 画面中扫码登录。
5. 点击“同步 Cookie”或“同步状态”。

如果接口返回 `40102` / `CHALLENGE_REQUIRED`，说明平台当前要求人工安全验证，不是 Kato parser 假失败。处理流程：

1. 打开 Kato dashboard 的“浏览器接管”。
2. 在“验证处理”区域选择对应平台，点击“打开验证页”。
3. 在 noVNC 画面里完成验证码或安全验证。
4. 点击同一行的“同步状态”。抖音会同步 Cookie 以及 localStorage/sessionStorage。
5. 重试刚才的 ServerX 任务。

这套流程适用于换环境、重启容器、平台挑战失效等情况。Kato 会把挑战状态写入任务日志，并返回明确错误码，不会把验证码页伪装成空结果。

serverx 也可以主动写入 Cookie：

```bash
curl -X POST "$KATO_BASE/api/hybrid/update_cookie" \
  -H "Authorization: Bearer $KATO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"service":"douyin","cookie":"sid_guard=xxx; sessionid=xxx;"}'
```

或使用平台路径：

```bash
curl -X POST "$KATO_BASE/api/bilibili/web/update_cookie" \
  -H "Authorization: Bearer $KATO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"service":"bilibili","cookie":"SESSDATA=xxx; bili_jct=xxx;"}'
```

## 抖音

抖音 service 使用容器内真实 Chrome 打开抖音 Web 页面，并监听 Web 网络响应解析搜索、详情和评论。生产建议先登录并同步 Cookie。

### 搜索视频

```text
GET /api/douyin/web/search_videos
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `keyword` / `query` | 搜索关键词 |
| `count` / `limit` / `page_size` | 单次返回数量，最大 100，默认 20 |
| `page` / `cursor` | 页码语义，当前映射到页面滚动分页 |

```bash
curl "$KATO_BASE/api/douyin/web/search_videos?keyword=课程&count=20" \
  -H "Authorization: Bearer $KATO_API_TOKEN"
```

返回字段兼容：

- `aweme_id` / `id`
- `desc` / `item_title` / `title`
- `share_url` / `url`
- `author.nickname` / `author.name`
- `statistics.digg_count`
- `statistics.comment_count`

### 链接转 aweme_id

```text
GET /api/douyin/web/get_aweme_id
```

```bash
curl "$KATO_BASE/api/douyin/web/get_aweme_id?url=https%3A%2F%2Fwww.douyin.com%2Fvideo%2F738xxx" \
  -H "Authorization: Bearer $KATO_API_TOKEN"
```

返回：

```json
{ "code": 200, "message": "success", "data": "738xxx" }
```

### 视频详情

```text
GET /api/douyin/web/fetch_one_video
```

```bash
curl "$KATO_BASE/api/douyin/web/fetch_one_video?aweme_id=738xxx" \
  -H "Authorization: Bearer $KATO_API_TOKEN"
```

返回在 `data.aweme_detail` 下。

### 一级评论

```text
GET /api/douyin/web/fetch_video_comments
```

```bash
curl "$KATO_BASE/api/douyin/web/fetch_video_comments?aweme_id=738xxx&cursor=0&count=20" \
  -H "Authorization: Bearer $KATO_API_TOKEN"
```

返回字段兼容：

- `cid` / `comment_id` / `id`
- `text` / `content` / `message`
- `user.nickname` / `user.name`
- `reply_comment_total`

### 子评论

```text
GET /api/douyin/web/fetch_video_comment_replies
```

```bash
curl "$KATO_BASE/api/douyin/web/fetch_video_comment_replies?aweme_id=738xxx&comment_id=comment_1&cursor=0&count=20" \
  -H "Authorization: Bearer $KATO_API_TOKEN"
```

子评论会带：

- `reply_id`
- `reply_to_reply_id`
- `parent_id`

## B站

B站 service 使用 B站 Web JSON 接口做只读采集。真实 smoke 显示匿名请求可能触发 `HTTP 412`，生产建议先用 noVNC 登录 B站并同步 Cookie。

### 搜索视频

```text
GET /api/bilibili/web/search_videos
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `keyword` / `query` | 搜索关键词 |
| `pn` / `page` | 页码，默认 1 |
| `ps` / `page_size` / `limit` | 单页数量，最大 100，默认 20 |

```bash
curl "$KATO_BASE/api/bilibili/web/search_videos?keyword=课程&pn=1&ps=20" \
  -H "Authorization: Bearer $KATO_API_TOKEN"
```

Kato 会过滤搜索结果中没有 `bvid` 的课程/广告卡片，只返回可继续抓详情和评论的视频项。

最低字段：

- `bvid` / `bv_id` / `bvId`
- `aid` / `id`
- `title` / `name`
- `author` / `uname`
- `mid`

### 视频详情

```text
GET /api/bilibili/web/fetch_one_video
```

```bash
curl "$KATO_BASE/api/bilibili/web/fetch_one_video?bvid=BV1xx" \
  -H "Authorization: Bearer $KATO_API_TOKEN"
```

字段兼容：

- `bvid` / `bv_id` / `bvId`
- `aid` / `id`
- `title` / `name`
- `desc` / `description` / `content`
- `owner.name` / `owner.uname`
- `owner.mid`
- `stat.view/reply/favorite/coin/share/like`

### 一级评论

```text
GET /api/bilibili/web/fetch_video_comments
```

```bash
curl "$KATO_BASE/api/bilibili/web/fetch_video_comments?bvid=BV1xx&pn=1&ps=20" \
  -H "Authorization: Bearer $KATO_API_TOKEN"
```

返回字段：

- `rpid` / `id` / `comment_id`
- `content.message`
- `message`
- `member.uname` / `member.name`
- `parent`
- `root`
- `rcount`

### 子评论

```text
GET /api/bilibili/web/fetch_comment_reply
```

```bash
curl "$KATO_BASE/api/bilibili/web/fetch_comment_reply?bvid=BV1xx&root=111&pn=1&ps=20" \
  -H "Authorization: Bearer $KATO_API_TOKEN"
```

`root`、`rpid` 或 `comment_id` 都可以作为父评论 ID。

## 限制和错误码

| 项 | 抖音 | B站 |
| --- | --- | --- |
| 关键词搜索单次最大返回 | 100 | 100 |
| 评论单页数量 | 100 | 100 |
| 分页 | 抖音 cursor / 页面滚动语义 | B站 `pn`/`ps` |
| 是否需要 Cookie | 强烈建议，需要评论稳定性 | 强烈建议，匿名会触发 412 |
| Cookie 失效错误码 | `40101` | `40101` |
| 人工验证错误码 | `40102` | `40102`（如后续接入挑战检测） |
| 默认 public 超时 | 600s | 600s |
| service 采集超时 | 抖音浏览器任务 180s | B站单次 fetch 60s |
| 限流建议 | 单平台串行或低并发，建议 <= 0.2 QPS | 建议 <= 0.2 QPS |
| 平台风控 | 会，尤其详情/评论/频繁访问 | 会，常见 412 |

常见错误：

| code | 含义 |
| --- | --- |
| `200` | 成功 |
| `40001` | 参数错误 |
| `40101` | Cookie 失效或未登录 |
| `40102` | 平台要求人工验证；到 Kato 控制台“浏览器接管”里的“验证处理”完成验证并同步状态 |
| `50001` | 上游平台或 Kato 内部采集错误 |
