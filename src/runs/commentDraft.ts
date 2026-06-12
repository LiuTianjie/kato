import { createHash } from "node:crypto";
import type { Note, ScoredPost } from "../domain/types.js";
import { COMMENT_MAX_LENGTH } from "./noteLink.js";

const OPENERS = [
  "这个点很有共鸣，",
  "你这条里最有价值的是，",
  "我也踩过类似的坑，",
  "这个方向确实值得展开，",
  "看到这里我想到一个补充，"
];

const BRIDGES = [
  "尤其是把流程固定下来之后，效率提升会更稳定。",
  "比起单纯收藏工具，更关键的是让它进入每天真的会用的场景。",
  "如果能再加一个复盘入口，后面迭代起来会轻很多。",
  "我觉得判断工具好不好用，最终还是看它能不能减少重复动作。",
  "这类方法最容易卡在第一步，所以拆成小流程会更好落地。"
];

export function draftComment(post: ScoredPost, note: Note | null): string {
  const seed = hashNumber(`${post.id}:${note?.url ?? "none"}`);
  const opener = OPENERS[seed % OPENERS.length];
  const bridge = BRIDGES[Math.floor(seed / 3) % BRIDGES.length];
  const concrete = concreteResponse(post);

  if (!note) {
    return trimComment(`${opener}${concrete}${bridge}`);
  }

  const relation = relationLine(note);
  return trimComment(`${opener}${concrete}${bridge} ${relation}`);
}

function concreteResponse(post: ScoredPost): string {
  const keyword = post.matchedKeywords[0] ?? "效率工具";
  if (/notion/i.test(post.title) || post.title.includes("Notion")) {
    return "Notion模板如果一开始做得太复杂，后面维护成本会很高。";
  }
  if (/提示词|prompt/i.test(`${post.title}${post.snippet}`)) {
    return "提示词真正有用的地方不是句子本身，而是把输入、约束和输出标准讲清楚。";
  }
  if (/写作|内容/.test(`${post.title}${post.snippet}`)) {
    return "AI写作最容易被忽略的是前面的素材整理和后面的人工判断。";
  }
  if (/自动化|工作流/.test(`${post.title}${post.snippet}`)) {
    return "工作流要落地，最好先从一个重复动作开始，而不是一上来就搭大系统。";
  }
  return `${keyword}这类内容，最后还是要回到真实场景里验证。`;
}

function relationLine(note: Note): string {
  return `「${note.title}」里也有类似思路。`;
}

function trimComment(comment: string): string {
  const compact = comment.replace(/\s+/g, " ").trim();
  if (compact.length <= COMMENT_MAX_LENGTH) return compact;
  return compact.slice(0, COMMENT_MAX_LENGTH).trim();
}

function hashNumber(value: string): number {
  return createHash("sha256").update(value).digest().readUInt32BE(0);
}
