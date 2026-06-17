export function setButtonLoading(button, loading, label = "处理中") {
  if (!button) return;
  if (loading) {
    button.dataset.idleText = button.textContent;
    button.disabled = true;
    button.classList.add("is-loading");
    button.innerHTML = button.classList.contains("small")
      ? `<span>${label}</span>`
      : button.classList.contains("icon-button")
      ? `<span class="spinner small-spinner"></span>`
      : `<span class="spinner small-spinner"></span><span>${label}</span>`;
    return;
  }
  button.disabled = false;
  button.classList.remove("is-loading");
  if (button.dataset.idleText) {
    button.textContent = button.dataset.idleText;
    delete button.dataset.idleText;
  }
}

export async function withButtonLoading(button, label, task) {
  setButtonLoading(button, true, label);
  try {
    return await task();
  } finally {
    setButtonLoading(button, false);
  }
}

export function setRegionLoading(element, loading) {
  if (!element) return;
  element.classList.toggle("is-region-loading", loading);
  element.setAttribute("aria-busy", loading ? "true" : "false");
}
