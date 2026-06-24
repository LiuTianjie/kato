export type PlatformId = "xhs" | "bilibili" | "douyin";

export interface PlatformRequestOptions {
  signal?: AbortSignal;
  cursor?: string;
  index?: number;
  pageArea?: string;
  sortType?: string;
  noteType?: string;
  timeFilter?: string;
  pageSize?: number;
  searchId?: string;
}

export interface PlatformPostBase {
  id: string;
  url: string;
  title: string;
  snippet: string;
  author?: string;
  likeCount?: number;
  commentCount?: number;
  publishedAt?: string;
  platform?: PlatformId;
  raw?: unknown;
}

export interface PlatformPost extends PlatformPostBase {
  platform: PlatformId;
}

export interface PlatformCommentBase {
  id: string;
  content: string;
  author?: string;
  parentId?: string;
  platform?: PlatformId;
  raw?: unknown;
}

export interface PlatformComment extends PlatformCommentBase {
  platform: PlatformId;
}

export interface ReadOnlyPlatformAdapter<
  Post extends PlatformPostBase = PlatformPost,
  Comment extends PlatformCommentBase = PlatformComment
> {
  readonly platformId: PlatformId;
  searchPosts(query: string, limit: number, options?: PlatformRequestOptions): Promise<Post[]>;
  getPost(post: Post | string, options?: PlatformRequestOptions): Promise<Post | null>;
  getComments?(post: Post | string, limit: number, options?: PlatformRequestOptions): Promise<Comment[]>;
  close?(): Promise<void>;
}

export interface WritablePlatformAdapter<
  Post extends PlatformPostBase = PlatformPost,
  Comment extends PlatformCommentBase = PlatformComment
> extends ReadOnlyPlatformAdapter<Post, Comment> {
  openPost?(url: string, options?: PlatformRequestOptions): Promise<void>;
  prefillComment?(url: string, comment: string, options?: PlatformRequestOptions): Promise<boolean>;
  publishComment?(post: Post, comment: string, options?: PlatformRequestOptions): Promise<boolean>;
  likePost?(post: Post, options?: PlatformRequestOptions): Promise<boolean>;
}

export interface PlatformCapabilities {
  search: boolean;
  detail: boolean;
  comments: boolean;
  write: boolean;
  login: boolean;
}

export interface PlatformSpec {
  id: PlatformId;
  label: string;
  serviceName: string;
  homeUrl: string;
  loginUrl?: string;
  cookieDomains: string[];
  defaultDataDir: string;
  defaultServicePort?: number;
  viewerRuntimeUrl?: string;
  workerRuntimeUrl?: string;
  serviceUrl?: string;
  implemented: boolean;
  capabilities: PlatformCapabilities;
  searchUrl(query: string): string;
}
