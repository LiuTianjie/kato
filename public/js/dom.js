export const $ = (id) => document.getElementById(id);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function setText(id, value) {
  $(id).textContent = value;
}

export function setHtml(id, value) {
  $(id).innerHTML = value;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function escapeAttr(value) {
  return escapeHtml(value || "");
}

export function loadingBlock(label = "加载中") {
  return `
    <div class="loading-block" aria-live="polite">
      <span class="spinner"></span>
      <span>${escapeHtml(label)}</span>
    </div>
  `;
}
