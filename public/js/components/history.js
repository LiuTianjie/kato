import { $, escapeAttr, escapeHtml, loadingBlock, setHtml, setText } from "../dom.js";
import { formatTime, interactionLabel, toDateKey } from "../format.js";
import { POSTED_STATUSES, state } from "../state.js";

export function renderMetrics() {
  const totals = state.dashboard?.totals || {};
  const today = new Date().toISOString().slice(0, 10);
  const todayInteracted = (state.dashboard?.recentInteractions || []).filter(
    (row) => POSTED_STATUSES.has(row.status) && toDateKey(row.updated_at || row.created_at) === today
  ).length;
  const metrics = [
    ["已互动数量", totals.posted ?? 0],
    ["今日互动数", todayInteracted],
    ["总发布数", totals.posted ?? 0],
    ["跳过数", totals.skipped ?? 0],
  ];
  setHtml(
    "metrics",
    metrics.map(([label, value]) => `<article class="metric"><span>${label}</span><strong>${value}</strong></article>`).join("")
  );
}

export function renderHistoryLoading() {
  setText("historyCount", "加载中");
  setHtml("historyList", loadingBlock("正在读取历史数据"));
}

export function renderHistory() {
  const rows = filteredHistory();
  setText("historyCount", `${rows.length} 条`);
  setHtml("historyList", rows.map(renderHistoryRow).join("") || `<div class="empty">暂无历史记录</div>`);
}

export function clearHistoryFilters() {
  $("historyRunFilter").value = "";
  $("historyDateFilter").value = "";
  $("historyKeywordFilter").value = "";
}

function renderHistoryRow(row) {
  return `
    <article class="history-row">
      <div>
        <div class="row-kicker">
          <span class="status ${row.status === "skipped" ? "muted" : "ok"}">${interactionLabel(row.status)}</span>
          <span>Run ${row.run_id}</span>
          <span>${formatTime(row.updated_at || row.created_at)}</span>
        </div>
        <a class="post-title" href="${escapeAttr(row.post_url)}" target="_blank" rel="noreferrer">${escapeHtml(row.post_title)}</a>
        <div class="post-meta">${escapeHtml(row.author || "未知作者")} · 关联笔记：${escapeHtml(row.note_title || "无")}</div>
      </div>
      <div class="history-comment">${escapeHtml(row.draft_comment || "无评论内容")}</div>
      <div class="history-result">${interactionLabel(row.status)}</div>
    </article>
  `;
}

function filteredHistory() {
  const date = $("historyDateFilter").value;
  const keyword = $("historyKeywordFilter").value.trim().toLowerCase();
  return state.history.filter((row) => {
    if (date && toDateKey(row.updated_at || row.created_at) !== date) return false;
    if (!keyword) return true;
    return [row.post_title, row.draft_comment, row.note_title, row.reason, row.author]
      .join(" ")
      .toLowerCase()
      .includes(keyword);
  });
}
