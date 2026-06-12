export const DEFAULT_KEYWORDS = [
  "AI工具",
  "效率工具",
  "ChatGPT工作流",
  "自动化办公",
  "Notion效率",
  "提示词",
  "知识管理",
  "学习效率",
  "AI写作",
  "副业工具"
];

export function parseKeywordArg(raw?: string): string[] {
  if (!raw) return DEFAULT_KEYWORDS;
  return raw
    .split(/[,\n|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
