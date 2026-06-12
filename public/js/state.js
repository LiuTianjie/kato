export const ACTIVE_STATUSES = new Set(["new", "drafted"]);
export const POSTED_STATUSES = new Set(["posted_via_mcp", "posted_by_user"]);
export const ARCHIVED_STATUSES = new Set(["posted_via_mcp", "posted_by_user", "skipped"]);

export const state = {
  dashboard: null,
  queue: [],
  history: [],
  notes: [],
  runs: [],
  debugScreenshots: [],
  searchPosts: [],
  searchMeta: null,
  selected: new Set(),
  pendingRows: new Map(),
  pendingBulkAction: null,
};

export function selectedIds() {
  return [...state.selected];
}
