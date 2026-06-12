import { $, $$, escapeAttr, escapeHtml, loadingBlock, setHtml, setText } from "../dom.js";
import { state } from "../state.js";

let handlers = {
  onToggleNote: () => {},
};

export function configureNotes(nextHandlers) {
  handlers = { ...handlers, ...nextHandlers };
}

export function renderNotesLoading() {
  setText("noteCount", "加载中");
  setHtml("noteList", loadingBlock("正在读取笔记库"));
}

export function renderNotes() {
  const activeCount = state.notes.filter((note) => note.status === "active").length;
  setText("noteCount", `${activeCount} 启用 / ${state.notes.length} 总数`);
  setHtml("noteList", state.notes.map(renderNote).join("") || `<div class="empty">暂无笔记，请先同步我的小红书笔记</div>`);
  $$("[data-note-status]").forEach((button) => {
    button.addEventListener("click", () => handlers.onToggleNote(button));
  });
}

function renderNote(note) {
  return `
    <article class="note-row ${note.status === "paused" ? "muted-row" : ""}">
      <div>
        <div class="row-kicker">
          <span class="status ${note.status === "active" ? "ok" : "muted"}">${note.status === "active" ? "启用" : "停用"}</span>
        </div>
        <a class="post-title" href="${escapeAttr(note.url)}" target="_blank" rel="noreferrer">${escapeHtml(note.title)}</a>
        <p>${escapeHtml(note.summary)}</p>
        <div class="note-meta">
          <strong>关键词</strong>
          <span>${escapeHtml((note.keywords || []).join("、") || "未提取")}</span>
        </div>
        <div class="note-meta">
          <strong>适合场景</strong>
          <span>${escapeHtml((note.scenarios || []).join("、") || "相关话题讨论")}</span>
        </div>
      </div>
      <button class="secondary" data-note-status="${note.status === "active" ? "paused" : "active"}" data-note-id="${note.id}">
        ${note.status === "active" ? "停用" : "启用"}
      </button>
    </article>
  `;
}
