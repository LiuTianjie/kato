import { dashboardApi } from "./api.js";
import { $, setText } from "./dom.js";
import { appendClientLog, watchOperation } from "./components/logPanel.js";
import { renderQueue } from "./components/queue.js";
import { errorMessage } from "./format.js";
import { withButtonLoading } from "./loading.js";
import { state, selectedIds } from "./state.js";

export function createOperations({ refreshAll, refreshQueue, refreshHistory, refreshDebugScreenshots }) {
  let activeRunOperationId = null;
  return {
    startRun: async (button) => {
      if (activeRunOperationId) {
        button.disabled = true;
        try {
          await dashboardApi.cancelOperation(activeRunOperationId);
          setText("runMessage", "正在取消搜索，等待当前 MCP 步骤结束...");
        } catch (error) {
          setText("runMessage", `取消失败：${errorMessage(error)}`);
        } finally {
          button.disabled = false;
        }
        return;
      }

        const message = $("runMessage");
        if (!state.notes.some((note) => note.status === "active")) {
          message.textContent = "请先同步并启用至少一条我的笔记";
          return;
        }
        message.textContent = "正在搜索帖子并加入队列...";
        setRunButtonCancellable(button, true);
        try {
          const result = await dashboardApi.startRun({
            limit: Number($("runLimit").value || 30),
            keywords: $("keywords").value.trim(),
            generateDrafts: false,
            async: true,
          });
          activeRunOperationId = result.operationId;
          $("runFilter").value = "";
          let liveRefresh = Promise.resolve();
          const completed = await watchOperation(result.operationId, {
            onTick: () => {
              liveRefresh = liveRefresh.then(() => refreshQueue({ showLoading: false })).catch(() => {});
              return liveRefresh;
            },
          });
          if (completed.state === "cancelled") {
            message.textContent = "搜索已取消，已入队的帖子会保留在队列里";
          } else {
            message.textContent = completed.result
            ? `Run ${completed.result.runId} 入队 ${completed.result.queued ?? completed.result.drafted} 条`
            : "搜索完成";
          }
          await refreshAll();
          if (completed.result?.runId) {
            $("runFilter").value = String(completed.result.runId);
            await refreshQueue();
          }
        } catch (error) {
          message.textContent = errorMessage(error);
        } finally {
          activeRunOperationId = null;
          setRunButtonCancellable(button, false);
        }
    },

    syncNotes: (button) =>
      withButtonLoading(button, "同步中", async () => {
        const message = $("syncMessage");
        message.textContent = "正在同步你的主页笔记...";
        try {
          const result = await dashboardApi.syncNotes({
            limit: Number($("syncLimit").value || 30),
            async: true,
          });
          const completed = await watchOperation(result.operationId);
          const summary = completed.result || {};
          message.textContent = `已同步 ${summary.imported ?? 0} 条，跳过 ${summary.skipped ?? 0} 条${
            summary.profileName ? ` · ${summary.profileName}` : ""
          }`;
          await refreshAll();
        } catch (error) {
          message.textContent = errorMessage(error);
        }
      }),

    generatePublishSelected: (button) =>
      withButtonLoading(button, "评论并发布中", async () => {
        const ids = selectedIds();
        if (!ids.length) return;
        if (!confirm(`确认对 ${ids.length} 条帖子生成评论，并直接发布和点赞？`)) return;
        markRowsPending(ids, "generate-publish", "评论并发布中");
        state.pendingBulkAction = "generate-publish";
        setText("runMessage", `正在为 ${ids.length} 条帖子评论并发布...`);
        try {
          const result = await dashboardApi.generateAndPublish(ids);
          const completed = await watchOperation(result.operationId, {
            onTick: createOperationTickRefresher(refreshQueue, refreshHistory),
          });
          const summary = completed.result || {};
          setText(
            "runMessage",
            `生成 ${summary.generated ?? 0} 条，发布 ${summary.published ?? 0} 条，跳过 ${summary.skipped ?? 0} 条`
          );
        } catch (error) {
          setText("runMessage", errorMessage(error));
          appendClientLog(`失败 · 评论并发布：${errorMessage(error)}`);
          await refreshDebugScreenshots?.();
        } finally {
          clearRowsPending(ids);
          state.pendingBulkAction = null;
          await refreshAll();
        }
      }),

    bulkStatus: (button, status) =>
      withButtonLoading(button, "跳过中", async () => {
        const ids = selectedIds();
        if (!ids.length) return;
        const label = "跳过";
        if (status === "skipped" && !confirm(`确认跳过 ${ids.length} 条帖子？跳过后会从互动队列移到历史数据。`)) {
          return;
        }
        markRowsPending(ids, status, "跳过中");
        state.pendingBulkAction = status;
        appendClientLog(`开始 · ${label} ${ids.length} 条`);
        try {
          await dashboardApi.updateInteractionStatus(ids, status);
          appendClientLog(`成功 · ${label} ${ids.length} 条`);
          await refreshAll();
        } catch (error) {
          appendClientLog(`失败 · ${label}：${errorMessage(error)}`);
        } finally {
          clearRowsPending(ids);
          state.pendingBulkAction = null;
          renderQueue();
        }
      }),

    runRowAction: async (button) => {
      const id = Number(button.dataset.id);
      const action = button.dataset.rowAction;
      if (state.pendingRows.has(id)) return;
      if (action === "generate-publish" && !confirm("确认生成评论并直接发布、点赞这条帖子？")) return;
      if (action === "skipped" && !confirm("确认跳过这条帖子？跳过后会从互动队列移到历史数据。")) return;
      markRowsPending([id], action, rowLoadingLabel(action));
      try {
        await withButtonLoading(button, rowLoadingLabel(action), async () => {
        try {
          if (action === "generate-publish") {
            const result = await dashboardApi.generateAndPublish([id]);
            await watchOperation(result.operationId, {
              onTick: createOperationTickRefresher(refreshQueue, refreshHistory),
            });
            await refreshDebugScreenshots?.();
          } else if (action === "generate") {
            const result = await dashboardApi.generateComments([id]);
            let liveRefresh = Promise.resolve();
            await watchOperation(result.operationId, {
              onTick: (operation) => {
                syncItemStatuses(operation);
                liveRefresh = liveRefresh.then(() => refreshQueue({ showLoading: false })).catch(() => {});
                return liveRefresh;
              },
            });
          } else {
            await dashboardApi.updateInteractionStatus([id], action);
            appendClientLog("成功 · 跳过 1 条");
          }
          await refreshAll();
        } catch (error) {
          appendClientLog(`失败 · 操作队列项：${errorMessage(error)}`);
          if (action === "generate-publish") await refreshDebugScreenshots?.();
        }
        });
      } finally {
        clearRowsPending([id]);
        renderQueue();
      }
    },

    saveDraft: (id, button, options = {}) =>
      withButtonLoading(button, "保存中", async () => {
        const textarea = document.querySelector(`[data-draft="${id}"]`);
        if (!textarea) return;
        const row = state.queue.find((item) => Number(item.id) === id);
        if (row && textarea.value === row.draft_comment) return;
        try {
          await dashboardApi.saveDraft(id, textarea.value);
          if (row) row.draft_comment = textarea.value;
          if (!options.quiet) appendClientLog("成功 · 评论草稿已保存");
        } catch (error) {
          appendClientLog(`失败 · 保存草稿：${errorMessage(error)}`);
        }
      }),

    toggleNote: (button) =>
      withButtonLoading(button, "更新中", async () => {
        try {
          await dashboardApi.updateNoteStatus(Number(button.dataset.noteId), button.dataset.noteStatus);
          appendClientLog(`成功 · ${button.dataset.noteStatus === "active" ? "启用" : "停用"}笔记`);
          await refreshAll();
        } catch (error) {
          appendClientLog(`失败 · 更新笔记状态：${errorMessage(error)}`);
        }
      }),
  };
}

function rowLoadingLabel(action) {
  if (action === "generate-publish") return "评论并发布中";
  if (action === "generate") return "生成中";
  if (action === "skipped") return "跳过中";
  return "处理中";
}

function markRowsPending(ids, action, label) {
  ids.forEach((id) => {
    state.pendingRows.set(Number(id), { action, label });
  });
  renderQueue();
}

function clearRowsPending(ids) {
  ids.forEach((id) => {
    state.pendingRows.delete(Number(id));
  });
}

function setRunButtonCancellable(button, cancellable) {
  if (!button) return;
  button.disabled = false;
  button.classList.toggle("danger", cancellable);
  button.classList.toggle("primary", !cancellable);
  button.textContent = cancellable ? "取消入队" : "搜索帖子入队";
}

function syncItemStatuses(operation) {
  const statuses = operation?.itemStatuses || {};
  Object.entries(statuses).forEach(([id, label]) => {
    const numericId = Number(id);
    const pending = state.pendingRows.get(numericId);
    if (pending) {
      state.pendingRows.set(numericId, { ...pending, label });
    }
  });
}

function createOperationTickRefresher(refreshQueue, refreshHistory) {
  let liveRefresh = Promise.resolve();
  return (operation) => {
    syncItemStatuses(operation);
    liveRefresh = liveRefresh
      .then(async () => {
        await refreshQueue({ showLoading: false });
        await refreshHistory?.({ showLoading: false });
      })
      .catch(() => {});
    return liveRefresh;
  };
}
