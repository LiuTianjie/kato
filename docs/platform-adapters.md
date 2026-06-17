# 平台 Adapter 接入指南

Kato 的浏览器能力已经抽成可注册的 `browser-runtime` slot：Chrome、Xvfb、noVNC、内部 CDP、健康检查、重启恢复、日志、lease 和 cookie 导出都属于 runtime。小红书、B 站、抖音这类平台只应该在 adapter/service 层处理平台差异。

## 分层边界

| 层 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| `browser-runtime` slot | 启动/重启 Chrome、维护 noVNC、内部 CDP、profile lock 清理、基础日志、lease 和健康检查 | 不理解小红书、B 站、抖音页面结构 |
| 平台 service | 平台登录态、搜索、详情、评论读取、平台字段解析、分页游标、随机延迟、任务队列、worker lease 获取/释放 | 不直接暴露 CDP 到公网，不重复启动 Chrome |
| platform adapter | 把平台 service 的结果归一化为 Kato 业务对象 | 不写 dashboard 路由和鉴权 |
| public API gateway | 鉴权、ServerX/TikHub 兼容路径、统一错误 envelope、请求取消传播 | 不解析平台 DOM |
| Dashboard | 展示任务、日志、noVNC 接管、手动重启 | 不持有平台抓取逻辑 |

第一版继续保持单容器部署：dashboard、多个 browser-runtime slot 和各平台 service 都在 `kato` 镜像内。每个平台默认拆成 viewer/worker 两个 runtime，后续平台多了，再考虑把 runtime 拆成独立服务。

## Runtime Slot 模型

每个平台至少有两类 runtime：

| 类型 | 用途 | noVNC | 任务执行 |
| --- | --- | --- | --- |
| `viewer` | 人工登录、扫码、观察页面 | 开启 | 不跑接口任务 |
| `worker` | 搜索、详情、评论等接口任务 | 关闭 | 通过 lease 串行执行 |

viewer 和 worker 不共享 `user-data-dir`。登录完成后，dashboard 或平台 service 从 viewer runtime 按平台域名导出 Cookie，再保存到平台 Cookie 文件并注入 worker context。对小红书、抖音这类会把放行态写入 Web Storage 的平台，还必须同步 localStorage/sessionStorage。这样人工打开登录页不会把 worker 正在跑的任务导航走，也不会因为 Chrome profile 锁导致 worker 崩溃。

默认 slot：

| 平台 | Viewer runtime | Worker runtime | 说明 |
| --- | --- | --- | --- |
| 小红书 | `http://127.0.0.1:18100` | `http://127.0.0.1:18101` | 已接入 |
| 抖音 | `http://127.0.0.1:18110` | `http://127.0.0.1:18111` | 已接入只读 |
| B 站 | `http://127.0.0.1:18120` | `http://127.0.0.1:18121` | 已接入只读 |

runtime 端口、CDP 端口、VNC/noVNC 端口都只在容器内部使用。Dashboard 通过 `/novnc/{platform}/...` 反代对应平台 viewer 画面。

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
- `src/platforms/registry.ts` 定义 XHS、B站、抖音的平台 metadata、默认主页、登录 URL、搜索 URL、cookie 域、viewer/worker runtime URL 和实现状态。
- `src/adapters/platform.ts` 是平台 adapter factory；当前 `xhs` 和 `douyin` 返回真实实现，B站通过 ServerX 兼容 public API 和 `mcp/bilibili/service/server.js` 提供采集能力。
- `src/adapters/xhsMcp.ts` 已实现 `WritablePlatformAdapter<XhsPost, XhsComment>`，是第一个平台实现。

不要把 B 站或抖音逻辑放进 `mcp/xiaohongshu/service/server.js`。新的平台 service 应该只连接本平台 worker runtime，并在每个浏览器任务前调用 `/browser/lease/acquire`，结束、取消或超时后调用 `/browser/lease/release`。Dashboard 登录入口只连接本平台 viewer runtime。

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

所有请求都要接收上游 abort signal。ServerX 或 dashboard 请求已经断开时，adapter 必须停止浏览器动作，不能让旧任务继续在 worker 里跑。

平台 service 里推荐封装一个通用执行器：

1. 请求 worker runtime `/health?ensure=1`，确认 Chrome/CDP 可用。
2. 获取 worker lease。
3. 连接 worker CDP，并开独立 tab 执行任务。
4. 将上游 abort、任务超时和浏览器错误统一转成平台错误 envelope。
5. `finally` 关闭 tab、释放 lease。

## B 站 Adapter 要点

B 站当前按只读采集接入：

- 搜索使用 B站 Web JSON 接口 `/x/web-interface/search/type`
- 详情使用 `/x/web-interface/view`
- 一级评论使用 `/x/v2/reply`
- 子评论使用 `/x/v2/reply/reply`
- 主键优先使用 `bvid`，没有时用 URL
- 评论分页使用 B站页码 `pn`/`ps`
- cookie 按 `.bilibili.com`、`.biligame.com` 域从 B站 viewer runtime 导出，再持久化为请求 Cookie header

匿名 B站接口可能偶发可用，但真实 smoke 已出现 `HTTP 412` 风控响应，所以生产不要依赖匿名采集。推荐先在 dashboard 打开“B站登录”的 noVNC 画面，扫码登录后点击“同步 B站 Cookie”；serverx 也可以通过 `/api/bilibili/web/update_cookie` 或 `/api/hybrid/update_cookie` 主动写入 Cookie。

## 抖音 Adapter 要点

抖音 v1 已按只读方式接入：

- 搜索、详情、评论分开实现，不要为了详情强行从搜索页点击进入
- URL 和 item id 要一起保存；详情页经常需要搜索结果里的上下文参数
- 评论分页要保留平台返回的 cursor，不要只用 offset 猜测
- cookie 按 `.douyin.com`、`.iesdouyin.com`、`.amemv.com` 等域从 Douyin viewer runtime 导出，再注入 Douyin worker runtime
- 同步状态时同时导出 Douyin viewer 的 localStorage/sessionStorage；否则 viewer 已通过验证但 worker 仍可能落到“验证码中间页”
- 当前实现复用 Douyin worker runtime 打开真实页面并监听抖音 Web 网络响应；同时借鉴 `douyin-download-api` 的 Web 参数模型，补齐 `msToken`、`webid`、`verifyFp/fp`、`item_type`、`cut_version`、`rcFT`、`pc_libra_divert` 等接口参数
- 不把 `douyin-download-api` 作为运行依赖，也不直接复制其签名算法源码；如需更稳定的 `X-Bogus` / `a_bogus`，可单独部署 signer 服务并通过 `DOUYIN_SIGNER_URL` 接入。`DOUYIN_SIGNER_REQUIRED=1` 可让 signer 失败时直接报错，默认 signer 失败会回退到浏览器同源 fetch

抖音页面变化更频繁，service 内要保留 `raw` payload 和结构化日志，方便线上出问题时从 dashboard 看见是哪一步解析失败。遇到验证码或安全验证时，service 应返回 `CHALLENGE_REQUIRED`，ServerX 兼容接口映射为 `40102`；Dashboard 里必须能通过“浏览器接管”里的“验证处理”完成：

1. 打开对应平台验证页。
2. 人工在 noVNC 里通过验证码/安全验证。
3. 点击“同步状态”，把 Cookie 和必要 storage 写入 worker。
4. 重试原任务。

不要把验证码页解析为空结果，也不要让任务在验证码页或页面内 fetch 上无界等待。

## Luma 部署关系

当前 `deploy/kato.luma.yml` 不需要因为未来平台预留额外公网端口。原则是：

- 只暴露 dashboard `4173`。
- 各平台 runtime、平台 service、CDP、VNC/noVNC 都保持容器内部。
- 新平台需要持久化登录态时，优先把数据放在已有 `/app/data` 下，例如 `/app/data/platforms/bilibili`、`/app/data/platforms/douyin`。
- 只有当某个平台必须保留大量图片/视频缓存时，再在 Luma manifest 里新增独立 volume。
- 多 runtime 场景比单 Chrome 更吃内存；当前 Luma manifest 已按小红书 + 抖音 + B站 viewer/worker 预留 8G limit / 6G reservation。上线后要继续观察 Chrome 常驻内存和页面崩溃日志。

不要把多个平台或 viewer/worker 指到同一个 profile 目录。直接改 `PROFILE_DIR` 路径会导致线上 cookie/profile 看起来像丢了；如需迁移，先导出 Cookie，再切目录并重新同步。

## 接入步骤

1. 在 `src/platforms/registry.ts` 添加平台 spec：`homeUrl`、`loginUrl`、`cookieDomains`、`viewerRuntimeUrl`、`workerRuntimeUrl`、`serviceUrl`。
2. 在 `scripts/start-kato.sh` 添加 viewer/worker runtime slot；业务 service 未实现时可先只预留，不默认启动 worker service。
3. 新建平台 service，只连接本平台 worker runtime，并实现 worker lease、随机延迟、abort 取消、日志和 Cookie 注入。
4. 实现搜索、详情、评论的 REST 最小接口；登录 Cookie 同步从本平台 viewer runtime 导出。
5. 新建 `src/adapters/<platform>.ts`，把平台 service 返回值归一化为 `PlatformPost`/`PlatformComment`。
6. 在 dashboard public API 层新增平台路由，例如 `/api/v1/bilibili/*` 或 `/api/v1/douyin/*`。
7. 在 `src/platforms/registry.ts` 把平台 `implemented` 改为 `true`，并在 `src/adapters/platform.ts` 接入真实 adapter。
8. 只在平台 API 稳定后，再考虑 ServerX 兼容路径。
9. 部署前跑 `npm run build`、`npm test`、`luma validate deploy/kato.luma.yml`。
