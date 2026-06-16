# 平台 Adapter 接入指南

Kato 的浏览器能力已经抽成 `browser-runtime`：Chrome、Xvfb、noVNC、内部 CDP、健康检查、重启恢复、日志和 cookie 同步都属于 runtime。小红书、B 站、抖音这类平台只应该在 adapter 层处理平台差异。

## 分层边界

| 层 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| `browser-runtime` | 启动/重启 Chrome、维护 noVNC、内部 CDP、profile lock 清理、基础日志和健康检查 | 不理解小红书、B 站、抖音页面结构 |
| 平台 service | 平台登录态、搜索、详情、评论读取、平台字段解析、分页游标、随机延迟、任务队列 | 不直接暴露 CDP 到公网，不重复启动 Chrome |
| platform adapter | 把平台 service 的结果归一化为 Kato 业务对象 | 不写 dashboard 路由和鉴权 |
| public API gateway | 鉴权、ServerX/TikHub 兼容路径、统一错误 envelope、请求取消传播 | 不解析平台 DOM |
| Dashboard | 展示任务、日志、noVNC 接管、手动重启 | 不持有平台抓取逻辑 |

第一版继续保持单容器部署：dashboard、browser-runtime 和各平台 service 都在 `kato` 镜像内。后续平台多了，再考虑把 runtime 拆成独立服务。

## 推荐目录

```text
mcp/
  xiaohongshu/service/server.js
  bilibili/service/server.js
  douyin/service/server.js

src/
  adapters/
    platform.ts
    xhsMcp.ts
    bilibili.ts
    douyin.ts
  platforms/
    registry.ts
    types.ts
```

当前已经落地的通用入口：

- `src/platforms/types.ts` 定义平台统一只读/写入 adapter 契约。
- `src/platforms/registry.ts` 定义 XHS、B站、抖音的平台 metadata、默认主页、搜索 URL、cookie 域和实现状态。
- `src/adapters/platform.ts` 是平台 adapter factory；当前 `xhs` 和 `douyin` 返回真实实现，`bilibili` 会明确报未实现。
- `src/adapters/xhsMcp.ts` 已实现 `WritablePlatformAdapter<XhsPost, XhsComment>`，是第一个平台实现。

不要把 B 站或抖音逻辑放进 `mcp/xiaohongshu/service/server.js`。新的平台 service 可以直接调用 `BROWSER_RUNTIME_URL=http://127.0.0.1:18100`，再通过内部 CDP 连接同一个 runtime。

## 通用 Adapter 契约

当前代码里的 `XhsPost`/`XhsComment` 是小红书命名。接入第二个平台时，建议先抽一层通用类型，再让 XHS/Bilibili/Douyin adapter 做映射。

```ts
export interface PlatformPost {
  platform: "xhs" | "bilibili" | "douyin";
  id: string;
  url: string;
  title: string;
  snippet: string;
  author?: string;
  likeCount?: number;
  commentCount?: number;
  publishedAt?: string;
  raw?: unknown;
}

export interface PlatformComment {
  id: string;
  content: string;
  author?: string;
  parentId?: string;
  raw?: unknown;
}

export interface PlatformAdapter {
  searchPosts(query: string, limit: number, options?: { signal?: AbortSignal }): Promise<PlatformPost[]>;
  getPost(post: PlatformPost | string, options?: { signal?: AbortSignal }): Promise<PlatformPost | null>;
  getComments?(post: PlatformPost | string, limit: number, options?: { signal?: AbortSignal }): Promise<PlatformComment[]>;
  close?(): Promise<void>;
}
```

代码里已经拆成 `ReadOnlyPlatformAdapter` 和 `WritablePlatformAdapter`。如果平台要支持写操作，再单独扩展 `publishComment`、`likePost`。读数据平台不要先暴露写能力。

## 平台 Service 最小接口

每个平台 service 建议先提供同构 REST，方便 adapter 复用：

```text
GET  /health
GET  /api/v1/login/status
GET  /api/v1/posts/search?keyword=&limit=&page=
POST /api/v1/posts/detail
POST /api/v1/posts/comments
GET  /api/v1/browser/logs?since=&limit=
```

返回 envelope 保持一致：

```json
{ "success": true, "data": { "posts": [], "items": [], "has_more": false } }
```

错误也保持一致：

```json
{ "success": false, "error": { "code": "INTERNAL_ERROR", "message": "..." } }
```

所有请求都要接收上游 abort signal。ServerX 或 dashboard 请求已经断开时，adapter 必须停止浏览器动作，不能让旧任务继续在 noVNC 里跑。

## B 站 Adapter 要点

B 站建议先做只读：

- 搜索页：`https://search.bilibili.com/all?keyword=<keyword>`
- 详情页：视频 URL 通常是 `https://www.bilibili.com/video/<bvid>`
- 主键优先使用 `bvid`，没有时用 URL
- 评论读取先做第一页和分页游标，字段归一化到 `PlatformComment`
- cookie 按 `.bilibili.com` 域同步，独立记录日志 source 为 `bilibili`

初版不要依赖页面上的中文按钮文案做核心解析，优先从页面请求返回的 JSON 或内嵌状态里抽字段；DOM 只作为兜底。

## 抖音 Adapter 要点

抖音 v1 已按只读方式接入：

- 搜索、详情、评论分开实现，不要为了详情强行从搜索页点击进入
- URL 和 item id 要一起保存；详情页经常需要搜索结果里的上下文参数
- 评论分页要保留平台返回的 cursor，不要只用 offset 猜测
- cookie 按 `.douyin.com` 域同步，独立记录日志 source 为 `douyin`
- 当前实现复用 `browser-runtime` 打开真实页面并监听抖音 Web 网络响应，不把 `douyin-download-api` 作为运行依赖

抖音页面变化更频繁，service 内要保留 `raw` payload 和结构化日志，方便线上出问题时从 dashboard 看见是哪一步解析失败。

## Luma 部署关系

当前 `deploy/kato.luma.yml` 不需要因为未来平台预留额外公网端口。原则是：

- 只暴露 dashboard `4173`。
- `18100` runtime、`18060` XHS service、未来 B 站/抖音 service、`9224` CDP、`5900` VNC、`6080` noVNC 都保持容器内部。
- 新平台需要持久化登录态时，优先把数据放在已有 `/app/data` 下，例如 `/app/data/platforms/bilibili`、`/app/data/platforms/douyin`。
- 只有当某个平台必须保留大量图片/视频缓存时，再在 Luma manifest 里新增独立 volume。

不要改现有 `BROWSER_PROFILE_DIR`/`XHS_PROFILE_DIR` 指向，除非做 profile 迁移；直接改路径会导致线上 cookie/profile 看起来像丢了。

## 接入步骤

1. 新建平台 service，复用 `browser-runtime` 的 `/health?ensure=1` 和内部 CDP。
2. 实现搜索、详情、评论的 REST 最小接口，并接入任务队列、随机延迟、abort 取消和日志。
3. 新建 `src/adapters/<platform>.ts`，把平台 service 返回值归一化为 `PlatformPost`/`PlatformComment`。
4. 在 dashboard public API 层新增平台路由，例如 `/api/v1/bilibili/*` 或 `/api/v1/douyin/*`。
5. 在 `src/platforms/registry.ts` 把平台 `implemented` 改为 `true`，并在 `src/adapters/platform.ts` 接入真实 adapter。
6. 只在平台 API 稳定后，再考虑 ServerX 兼容路径。
7. 部署前跑 `npm run build`、`npm test`、`luma validate deploy/kato.luma.yml`。
