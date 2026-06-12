import { $, $$, escapeAttr, escapeHtml, loadingBlock, setHtml, setText } from "../dom.js";
import { interactionLabel } from "../format.js";
import { state } from "../state.js";

let handlers = {
  onRowAction: () => {},
  onSaveDraft: () => {},
};

export function configureQueue(nextHandlers) {
  handlers = { ...handlers, ...nextHandlers };
}

export function renderQueueLoading() {
  setText("queueCount", "加载队列中");
  setHtml("queue", loadingBlock("正在读取未互动队列"));
}

export function renderQueue() {
  setText("queueCount", `${state.queue.length} 条未互动`);
  setHtml("queue", state.queue.map(renderInteraction).join("") || `<div class="empty">暂无未互动帖子</div>`);
  bindQueueRows();
  updateSelectedCount();
}

export function selectAllVisible() {
  state.selected = new Set(state.queue.map((row) => Number(row.id)));
  renderQueue();
}

export function invertSelection() {
  const next = new Set();
  for (const row of state.queue) {
    const id = Number(row.id);
    if (!state.selected.has(id)) next.add(id);
  }
  state.selected = next;
  renderQueue();
}

export function updateSelectedCount() {
  setText("selectedCount", `已选 ${state.selected.size} 条`);
  const hasSelection = state.selected.size > 0;
  const hasPending = state.pendingRows.size > 0 || Boolean(state.pendingBulkAction);
  ["generatePublishSelected", "skipSelected"].forEach((id) => {
    $(id).disabled = !hasSelection || hasPending;
  });
}

function renderInteraction(row) {
  const checked = state.selected.has(Number(row.id)) ? "checked" : "";
  const draft = row.draft_comment || "";
  const pending = pendingFor(row);
  const workflow = pending ? renderWorkflowSteps(pending.label) : "";
  return `
    <article class="queue-row ${pending ? "is-pending" : ""}">
      <label class="row-check">
        <input type="checkbox" data-select="${row.id}" ${checked} ${pending ? "disabled" : ""} aria-label="选择 ${escapeHtml(row.post_title)}" />
      </label>
      <div class="post-block">
        <div class="row-kicker">
          <span class="status neutral">${interactionLabel(row.status)}</span>
          <span>Run ${row.run_id}</span>
          ${pending ? `<span class="status loading-status"><span class="spinner small-spinner"></span>${escapeHtml(pending.label)}</span>` : ""}
        </div>
        <a class="post-title" href="${escapeAttr(row.post_url)}" target="_blank" rel="noreferrer">${escapeHtml(row.post_title)}</a>
        <div class="post-meta">${escapeHtml(row.author || "未知作者")} · 赞 ${row.like_count ?? 0} · 评 ${row.comment_count ?? 0}</div>
        <div class="reason">${escapeHtml(row.reason || "暂无推荐理由")}</div>
        ${workflow}
      </div>
      <div class="row-workbench ${draft ? "has-draft" : "is-awaiting-draft"}">
        <div class="workbench-meta">
          <div class="note-block">
            <span class="field-label">匹配笔记</span>
            ${
              row.note_url
                ? `<a href="${escapeAttr(row.note_url)}" target="_blank" rel="noreferrer">${escapeHtml(row.note_title || "已匹配")}</a>`
                : `<span class="pending-note">发布时自动匹配</span>`
            }
          </div>
          <div class="row-actions">
            ${renderRowActions(row)}
          </div>
        </div>
        <div class="draft-block">
          <span class="field-label">评论内容</span>
          ${
            draft
              ? `<textarea class="draft-editor" data-draft="${row.id}" rows="4" ${pending ? "disabled" : ""}>${escapeHtml(draft)}</textarea>
                 <button class="secondary small save-draft-button" data-save-draft="${row.id}" ${pending ? "disabled" : ""}>保存草稿</button>`
              : `<div class="empty-draft"><span>等待执行</span><strong>生成评论后自动发布</strong></div>`
          }
        </div>
      </div>
    </article>
  `;
}

function renderRowActions(row) {
  const pending = pendingFor(row);
  return `
    ${actionButton(row, "generate-publish", "评论并发布", "primary", pending)}
    ${actionButton(row, "skipped", "跳过", "secondary", pending)}
  `;
}

function actionButton(row, action, label, tone, pending) {
  const isCurrentAction =
    pending?.action === action ||
    (pending && action === "generate" && pending.action === "bulk-generate") ||
    (pending && action === "generate-publish" && pending.action === "generate-publish");
  const content = isCurrentAction
    ? `<span class="spinner small-spinner"></span><span>${escapeHtml(pending.label)}</span>`
    : escapeHtml(label);
  return `
    <button
      class="${tone} ${isCurrentAction ? "is-loading" : ""}"
      data-row-action="${action}"
      data-id="${row.id}"
      ${pending ? "disabled" : ""}
    >${content}</button>
  `;
}

function renderWorkflowSteps(currentLabel) {
  const steps = ["读取详情", "生成评论", "发布评论", "点赞", "已完成"];
  const currentIndex = steps.indexOf(currentLabel);
  return `
    <div class="workflow-steps" aria-label="任务流程">
      ${steps
        .map((step, index) => {
          const stateClass =
            currentLabel === "失败"
              ? index <= Math.max(0, currentIndex) ? "done" : ""
              : index < currentIndex || currentLabel === "已完成"
                ? "done"
                : index === currentIndex
                  ? "current"
                  : "";
          return `<span class="${stateClass}">${escapeHtml(step)}</span>`;
        })
        .join("")}
    </div>
  `;
}

function pendingFor(row) {
  return state.pendingRows.get(Number(row.id));
}

function bindQueueRows() {
  $$("[data-select]").forEach((input) => {
    input.addEventListener("change", () => {
      const id = Number(input.dataset.select);
      input.checked ? state.selected.add(id) : state.selected.delete(id);
      updateSelectedCount();
    });
  });
  $$("[data-row-action]").forEach((button) => {
    button.addEventListener("click", () => handlers.onRowAction(button));
  });
  $$("[data-save-draft]").forEach((button) => {
    button.addEventListener("click", () => handlers.onSaveDraft(Number(button.dataset.saveDraft), button));
  });
  $$("[data-draft]").forEach((textarea) => {
    textarea.addEventListener("blur", () => handlers.onSaveDraft(Number(textarea.dataset.draft), null, { quiet: true }));
  });
}
