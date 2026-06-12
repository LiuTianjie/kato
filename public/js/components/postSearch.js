import { dashboardApi } from "../api.js";
import { $, escapeAttr, escapeHtml, loadingBlock, setHtml, setText } from "../dom.js";
import { errorMessage } from "../format.js";
import { state } from "../state.js";
import { withButtonLoading } from "../loading.js";
import { appendClientLog } from "./logPanel.js";

export function bindPostSearch() {
  $("postSearchButton").addEventListener("click", () => searchPosts($("postSearchButton")));
  $("postSearchKeywords").addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      searchPosts($("postSearchButton"));
    }
  });
}

export function renderPostSearchEmpty() {
  setText("postSearchCount", "未搜索");
  setHtml("postSearchResults", `<div class="empty">输入关键词后搜索，只展示结果，不加入互动队列</div>`);
}

async function searchPosts(button) {
  const keywords = $("postSearchKeywords").value.trim();
  const limit = Number($("postSearchLimit").value || 20);
  setText("postSearchCount", "搜索中");
  setHtml("postSearchResults", loadingBlock("正在搜索小红书帖子"));
  appendClientLog("开始 · 独立帖子搜索");

  return withButtonLoading(button, "搜索中", async () => {
    try {
      const result = await dashboardApi.searchPosts({ keywords, limit });
      state.searchPosts = result.posts || [];
      state.searchMeta = { keywords: result.keywords || [], limit: result.limit };
      renderPostSearchResults();
      appendClientLog(`成功 · 搜索到 ${state.searchPosts.length} 条帖子，不写入队列`);
    } catch (error) {
      setText("postSearchCount", "搜索失败");
      setHtml("postSearchResults", `<div class="empty">搜索失败：${escapeHtml(errorMessage(error))}</div>`);
      appendClientLog(`失败 · 独立帖子搜索：${errorMessage(error)}`);
    }
  });
}

function renderPostSearchResults() {
  const keywords = state.searchMeta?.keywords?.join(" / ") || "默认关键词";
  setText("postSearchCount", `${state.searchPosts.length} 条结果 · ${keywords}`);
  setHtml(
    "postSearchResults",
    state.searchPosts.map(renderPost).join("") || `<div class="empty">没有搜索到帖子</div>`
  );
}

function renderPost(post) {
  const meta = [
    post.author || "未知作者",
    `赞 ${post.likeCount ?? 0}`,
    `评 ${post.commentCount ?? 0}`,
    post.publishedAt || ""
  ]
    .filter(Boolean)
    .join(" · ");
  return `
    <article class="search-post-row">
      <div class="post-block">
        <div class="row-kicker">
          <span class="status neutral">搜索结果</span>
          ${post.id ? `<span>${escapeHtml(post.id)}</span>` : ""}
        </div>
        <a class="post-title" href="${escapeAttr(post.url)}" target="_blank" rel="noreferrer">${escapeHtml(post.title || "未命名帖子")}</a>
        <div class="post-meta">${escapeHtml(meta)}</div>
        <div class="reason">${escapeHtml(post.snippet || "暂无摘要")}</div>
      </div>
      <div class="search-post-actions">
        <a class="secondary" href="${escapeAttr(post.url)}" target="_blank" rel="noreferrer">打开</a>
      </div>
    </article>
  `;
}
