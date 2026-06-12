import { $$ } from "../dom.js";

export function activateTab(name) {
  $$("[data-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === name);
  });
  $$(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${name}`);
  });
}

export function bindTabs() {
  $$("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => activateTab(button.dataset.tab));
  });
}
