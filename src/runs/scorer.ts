import type { ScoredPost, XhsPost } from "../domain/types.js";

export function scorePost(post: XhsPost, keywords: string[]): ScoredPost {
  const text = normalize(`${post.title} ${post.snippet}`);
  const matchedKeywords = keywords.filter((keyword) => text.includes(normalize(keyword)));
  const titleMatches = keywords.filter((keyword) => normalize(post.title).includes(normalize(keyword))).length;
  const engagement = Math.min(12, Math.log10(1 + (post.likeCount ?? 0) + (post.commentCount ?? 0) * 2) * 4);
  const substance = Math.min(8, Math.max(post.title.length, post.snippet.length) / 12);
  const score = matchedKeywords.length * 10 + titleMatches * 4 + engagement + substance;

  return {
    ...post,
    score: Number(score.toFixed(2)),
    matchedKeywords,
    reason: buildReason(matchedKeywords, post)
  };
}

export function isUsefulPost(post: ScoredPost): boolean {
  return getRuleRejectionReason(post) == null;
}

export function getBasicRejectionReason(post: XhsPost): string | null {
  if (!post.url.includes("xiaohongshu.com")) return "不是小红书链接";
  const text = `${post.title}${post.snippet}`;
  if (/抽奖|互赞|互关|薅羊毛|低价|代发|刷量/.test(text)) return "命中垃圾互动词";
  if (normalize(text).length < 18) return "标题和摘要信息太少";
  return null;
}

export function getRuleRejectionReason(post: ScoredPost): string | null {
  const basicReason = getBasicRejectionReason(post);
  if (basicReason) return basicReason;
  if (post.matchedKeywords.length === 0) return "未命中搜索关键词";
  if (post.score < 12) return `规则分过低：${post.score}`;
  return null;
}

function buildReason(keywords: string[], post: XhsPost): string {
  const parts = [`命中关键词：${keywords.join("、") || "无"}`];
  if ((post.commentCount ?? 0) > 20) parts.push("评论区已有讨论热度");
  if ((post.likeCount ?? 0) > 100) parts.push("帖子已有一定曝光");
  if (post.snippet.length > 20) parts.push("内容信息量足，适合具体补充");
  return parts.join("；");
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}
