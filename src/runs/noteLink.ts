export const COMMENT_MAX_LENGTH = 90;

export function sanitizePublishComment(comment: string): string {
  return comment
    .replace(/https?:\/\/[^\s，。！？、)）]+/gi, "")
    .replace(/(?:www\.)?xiaohongshu\.com\/[^\s，。！？、)）]+/gi, "")
    .replace(/小红书链接[:：]?\s*/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([，。！？、])/g, "$1")
    .trim();
}

export function ensureFixedNoteTitle(
  comment: string,
  noteTitle: string | null | undefined,
  maxLength = COMMENT_MAX_LENGTH
): string {
  const sanitized = sanitizePublishComment(comment);
  const title = sanitizeNoteTitle(noteTitle);
  if (!title) return trimToMax(sanitized, maxLength);

  const quotedTitle = `「${title}」`;
  if (sanitized.includes(quotedTitle)) return trimToMax(sanitized, maxLength);

  const suffix = buildNoteTitleSuffix(sanitized, quotedTitle);
  if (sanitized.length + suffix.length <= maxLength) return `${sanitized}${suffix}`.trim();

  const available = Math.max(0, maxLength - suffix.length);
  return trimToMax(`${trimToMax(sanitized, available).replace(/[，。！？、,.!?;；：:]+$/g, "")}${suffix}`.trim(), maxLength);
}

function sanitizeNoteTitle(title: string | null | undefined): string {
  return sanitizePublishComment(title ?? "")
    .replace(/[「」]/g, "")
    .slice(0, 28)
    .trim();
}

function trimToMax(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  const compact = value.trim();
  return compact.length <= maxLength ? compact : compact.slice(0, maxLength).trim();
}

function buildNoteTitleSuffix(comment: string, quotedTitle: string): string {
  const templates = [
    ` 这点和${quotedTitle}里讲的挺像。`,
    ` ${quotedTitle}里也有类似思路。`,
    ` 我在${quotedTitle}里也提过这类坑。`,
    ` ${quotedTitle}正好也聊到这个。`
  ];
  const index = Math.abs(hashString(`${comment}:${quotedTitle}`)) % templates.length;
  return templates[index];
}

function hashString(value: string): number {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return hash;
}
