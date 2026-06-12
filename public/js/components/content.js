import { dashboardApi } from "../api.js";
import { $, setText } from "../dom.js";
import { errorMessage } from "../format.js";
import { withButtonLoading } from "../loading.js";
import { appendClientLog, watchOperation } from "./logPanel.js";

let contentState = {
  projects: [],
  current: null,
  persona: null,
};

export async function refreshContentWorkspace() {
  const startButton = $("startContentProject");
  if (startButton?.classList.contains("is-loading")) {
    startButton.disabled = false;
    startButton.classList.remove("is-loading");
    startButton.textContent = startButton.dataset.idleText || "生成草稿";
    delete startButton.dataset.idleText;
  }
  await Promise.all([refreshPersona(), refreshContentProjects()]);
}

export function bindContentWorkspace() {
  $("startContentProject").addEventListener("click", () =>
    withButtonLoading($("startContentProject"), "生成中", startContentProject)
  );
  $("savePersona").addEventListener("click", () => withButtonLoading($("savePersona"), "保存中", savePersona));
  $("saveContentDraft").addEventListener("click", () =>
    withButtonLoading($("saveContentDraft"), "保存中", saveCurrentDraft)
  );
  $("approveContentDraft").addEventListener("click", () => updateCurrentDraftStatus("approved"));
  $("reviseContentDraft").addEventListener("click", () => updateCurrentDraftStatus("needs_revision"));
  $("rejectContentDraft").addEventListener("click", () => updateCurrentDraftStatus("rejected"));
  $("publishContentDraft").addEventListener("click", () =>
    withButtonLoading($("publishContentDraft"), "发布中", publishCurrentDraft)
  );
}

async function startContentProject() {
  const keyword = $("contentKeyword").value.trim();
  if (!keyword) {
    setText("contentMessage", "请输入关键词");
    return;
  }
  setText("contentMessage", "正在调研并生成草稿...");
  try {
    const result = await dashboardApi.startContentProject({
      keyword,
      contentType: $("contentType").value,
      sourceLimit: Number($("contentSourceLimit").value || 8),
      async: true,
    });
    const completed = await watchOperation(result.operationId, { timeoutMs: 180_000 });
    if (completed.state !== "completed") {
      setText("contentMessage", completed.error || "内容生产失败");
      return;
    }
    const summary = completed.result || {};
    setText("contentMessage", `已生成内容项目 ${summary.projectId}，参考 ${summary.sourceCount ?? 0} 篇帖子`);
    await refreshContentProjects(summary.projectId);
  } catch (error) {
    const message = errorMessage(error);
    setText("contentMessage", `${message} 正在刷新已生成项目...`);
    appendClientLog(`提醒 · 内容生产等待中断：${message}`);
    await refreshContentProjects();
  }
}

async function refreshPersona() {
  try {
    const result = await dashboardApi.getPersona();
    contentState.persona = result.persona || null;
    renderPersona();
    setText("personaMessage", result.generated ? "已根据当前笔记库生成默认人设，可直接修改保存" : "");
  } catch (error) {
    appendClientLog(`失败 · 读取账号人设：${errorMessage(error)}`);
  }
}

async function savePersona() {
  const body = {
    name: $("personaName").value,
    positioning: $("personaPositioning").value,
    targetReaders: $("personaReaders").value,
    tone: $("personaTone").value,
    commonPhrases: $("personaCommonPhrases").value,
    bannedPhrases: $("personaBannedPhrases").value,
    experienceBank: $("personaExperience").value,
    status: "active",
  };
  const result = await dashboardApi.savePersona(body);
  contentState.persona = result.persona;
  renderPersona();
  setText("personaMessage", "账号人设已保存");
}

async function refreshContentProjects(focusId) {
  try {
    const result = await dashboardApi.getContentProjects();
    contentState.projects = result.projects || [];
    renderContentProjectList();
    const id = focusId || contentState.current?.project?.id || contentState.projects[0]?.id;
    if (id) await loadContentProject(id);
    else renderEmptyContentDetail();
  } catch (error) {
    appendClientLog(`失败 · 读取内容项目：${errorMessage(error)}`);
  }
}

async function loadContentProject(id) {
  try {
    contentState.current = await dashboardApi.getContentProject(id);
    renderContentProjectList();
    renderContentDetail();
  } catch (error) {
    appendClientLog(`失败 · 读取内容详情：${errorMessage(error)}`);
  }
}

async function saveCurrentDraft() {
  const draft = contentState.current?.draft;
  if (!draft?.id) return;
  const saved = await dashboardApi.saveContentDraft(draft.id, {
    titleCandidates: splitLines($("draftTitles").value),
    coverText: $("draftCoverText").value,
    body: $("draftBody").value,
    tags: splitTags($("draftTags").value),
    imagePlan: splitLines($("draftImagePlan").value),
    visualStyle: $("draftVisualStyle").value,
    imagePaths: splitLines($("draftImagePaths").value),
  });
  contentState.current.draft = saved.draft;
  renderContentDetail();
  setText("contentMessage", "草稿已保存");
}

async function publishCurrentDraft() {
  const draft = contentState.current?.draft;
  if (!draft?.id) return;
  if (draft.status !== "approved") {
    setText("contentMessage", "草稿必须先审核通过，才能发布");
    return;
  }
  if (!splitLines($("draftImagePaths").value).length) {
    setText("contentMessage", "请先填写至少一个本地图片路径，并保存编辑");
    return;
  }
  const result = await dashboardApi.publishContentDraft(draft.id);
  const completed = await watchOperation(result.operationId, { timeoutMs: 240_000 });
  if (completed.state !== "completed") {
    setText("contentMessage", completed.error || "发布失败");
    await loadContentProject(contentState.current.project.id);
    return;
  }
  setText("contentMessage", "发布完成");
  await loadContentProject(contentState.current.project.id);
}

async function updateCurrentDraftStatus(status) {
  const draft = contentState.current?.draft;
  if (!draft?.id) return;
  try {
    const result = await dashboardApi.updateContentDraftStatus(draft.id, status);
    contentState.current.draft = result.draft;
    renderContentDetail();
    setText("contentMessage", `草稿状态已更新：${status}`);
  } catch (error) {
    appendClientLog(`失败 · 更新草稿状态：${errorMessage(error)}`);
  }
}

function renderPersona() {
  const persona = contentState.persona;
  $("personaName").value = persona?.name || "";
  $("personaPositioning").value = persona?.positioning || "";
  $("personaReaders").value = persona?.targetReaders || "";
  $("personaTone").value = persona?.tone || "";
  $("personaCommonPhrases").value = (persona?.commonPhrases || []).join("\n");
  $("personaBannedPhrases").value = (persona?.bannedPhrases || []).join("\n");
  $("personaExperience").value = persona?.experienceBank || "";
}

function renderContentProjectList() {
  const activeId = contentState.current?.project?.id;
  const html = contentState.projects.length
    ? contentState.projects
        .map(
          (project) => `
            <button class="content-project-item ${project.id === activeId ? "active" : ""}" data-content-project="${project.id}">
              <strong>${escapeHtml(project.keyword)}</strong>
              <span>${escapeHtml(project.contentType)} · ${escapeHtml(project.status)}</span>
            </button>
          `
        )
        .join("")
    : `<div class="empty">还没有内容项目。</div>`;
  $("contentProjectList").innerHTML = html;
  document.querySelectorAll("[data-content-project]").forEach((button) => {
    button.addEventListener("click", () => loadContentProject(Number(button.dataset.contentProject)));
  });
}

function renderContentDetail() {
  const detail = contentState.current;
  if (!detail?.project) {
    renderEmptyContentDetail();
    return;
  }
  const { project, sources, webSources, draft } = detail;
  $("contentDetailTitle").textContent = project.keyword;
  $("contentResearchSummary").textContent = project.researchSummary || "研究摘要生成中。";
  $("contentSources").innerHTML = sources.length
    ? sources.map(renderSource).join("")
    : `<div class="empty">暂无小红书参考来源。</div>`;
  $("webSources").innerHTML = webSources.length
    ? webSources.map(renderWebSource).join("")
    : `<div class="empty">暂无网页辅助资料。</div>`;
  renderContentEvents(detail.events || []);

  const hasDraft = Boolean(draft);
  $("contentDraftEditor").classList.toggle("hidden", !hasDraft);
  $("contentDraftEmpty").classList.toggle("hidden", hasDraft);
  if (!draft) return;
  $("draftStatus").textContent = draft.status;
  $("draftTitles").value = (draft.titleCandidates || []).join("\n");
  $("draftCoverText").value = draft.coverText || "";
  $("draftBody").value = draft.body || "";
  $("draftTags").value = (draft.tags || []).join("，");
  $("draftImagePlan").value = (draft.imagePlan || []).join("\n");
  $("draftImagePaths").value = (draft.imagePaths || []).join("\n");
  $("draftVisualStyle").value = draft.visualStyle || "";
  $("draftPersonaFit").textContent = draft.personaFit || "未说明人设贴合度。";
  $("draftReview").innerHTML = renderReview(draft);
  $("draftClaims").innerHTML = renderList(draft.factualClaims, "暂无证据事实。");
  $("draftSourceRefs").innerHTML = renderList(draft.sourceRefs, "暂无来源引用。");
  $("draftRisks").innerHTML = renderRisks(draft);
  $("draftPublishStatus").textContent = renderPublishStatus(draft);
  const canPublish = draft.status === "approved" && (draft.imagePaths || []).length > 0;
  $("publishContentDraft").disabled = !canPublish || draft.publishStatus === "publishing";
  $("approveContentDraft").disabled = (draft.unsupportedClaims || []).length > 0;
}

function renderEmptyContentDetail() {
  $("contentDetailTitle").textContent = "选择或创建一个内容项目";
  $("contentResearchSummary").textContent = "内容项目完成后，这里会显示选题研究摘要。";
  $("contentSources").innerHTML = `<div class="empty">暂无小红书参考来源。</div>`;
  $("webSources").innerHTML = `<div class="empty">暂无网页辅助资料。</div>`;
  $("contentDraftEditor").classList.add("hidden");
  $("contentDraftEmpty").classList.remove("hidden");
  $("contentEvents").innerHTML = `<div class="empty">暂无项目时间线。</div>`;
}

function renderSource(source) {
  return `
    <article class="source-item">
      <a href="${escapeAttr(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.title || source.url)}</a>
      <p>${escapeHtml(source.snippet || "")}</p>
      <span>${escapeHtml(source.author || "未知作者")} · ${Number(source.likeCount || 0)} 赞 · ${Number(source.commentCount || 0)} 评 · 热度 ${Number(source.heatScore || 0).toFixed(1)}</span>
      <small>${escapeHtml(source.heatReason || "暂无热度说明")}${source.detailError ? ` · 详情失败：${escapeHtml(source.detailError)}` : ""}</small>
    </article>
  `;
}

function renderWebSource(source) {
  return `
    <article class="source-item ${source.status !== "ok" ? "muted" : ""}">
      ${source.url ? `<a href="${escapeAttr(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.title)}</a>` : `<strong>${escapeHtml(source.title)}</strong>`}
      <p>${escapeHtml(source.snippet || source.error || "")}</p>
      <span>${escapeHtml(source.status)}${source.error ? ` · ${escapeHtml(source.error)}` : ""}</span>
    </article>
  `;
}

function renderReview(draft) {
  const review = draft.humanVoiceReview || {};
  const originality = draft.originalityCheck || {};
  return `
    <div class="review-pill ${review.passed ? "ok" : "warn"}">${review.passed ? "真人感通过" : "需要人工再看"}</div>
    <p>${escapeHtml((review.issues || []).join("；") || "未发现明显 AI 味问题。")}</p>
    <p>独特角度：${escapeHtml(originality.uniqueAngle || "未说明")}</p>
  `;
}

function renderRisks(draft) {
  const unsupported = (draft.unsupportedClaims || []).map((item) => `未支持：${item}`);
  return renderList([...(draft.riskNotes || []), ...unsupported], "暂无风险提示。");
}

function renderList(items, emptyText) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return `<div class="empty small-empty">${escapeHtml(emptyText)}</div>`;
  return `<ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderPublishStatus(draft) {
  const status = draft.publishStatus || "not_published";
  const parts = [`发布状态：${status}`];
  if (draft.publishedUrl) parts.push(`链接：${draft.publishedUrl}`);
  if (draft.publishError) parts.push(`错误：${draft.publishError}`);
  if (draft.status !== "approved") parts.push("需审核通过后发布");
  if (!(draft.imagePaths || []).length) parts.push("需填写本地图片路径");
  return parts.join(" · ");
}

function renderContentEvents(events) {
  $("contentEvents").innerHTML = events.length
    ? events
        .map(
          (event) => `
            <div class="event-row ${escapeAttr(event.level || "info")}">
              <span>${escapeHtml(formatEventTime(event.createdAt))}</span>
              <strong>${escapeHtml(event.stage || "event")}</strong>
              <p>${escapeHtml(event.message || "")}</p>
            </div>
          `
        )
        .join("")
    : `<div class="empty">暂无项目时间线。</div>`;
}

function formatEventTime(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return String(value);
  }
}

function splitLines(value) {
  return value
    .split(/\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitTags(value) {
  return value
    .split(/[，,、\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
