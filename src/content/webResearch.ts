import type { AppConfig } from "../config.js";
import type { WebResearchSource } from "../domain/types.js";

export interface WebResearchOptions {
  projectId: number;
  query: string;
  limit?: number;
}

export interface WebResearchProvider {
  research(options: WebResearchOptions): Promise<WebResearchSource[]>;
}

type PlaywrightModule = typeof import("playwright");

export function createWebResearchProvider(config: AppConfig): WebResearchProvider {
  if (process.env.WEB_RESEARCH_PROVIDER === "playwright") {
    return new PlaywrightWebResearchProvider(config);
  }
  return new DisabledWebResearchProvider();
}

export function shouldUseWebResearch(contentType: string): boolean {
  return contentType === "news" || contentType === "guide";
}

class DisabledWebResearchProvider implements WebResearchProvider {
  async research(options: WebResearchOptions): Promise<WebResearchSource[]> {
    return [
      {
        projectId: options.projectId,
        query: options.query,
        title: "网页调研未启用",
        url: "",
        snippet: "设置 WEB_RESEARCH_PROVIDER=playwright 后会启用 Chrome 网页辅助调研。",
        extractedText: "",
        status: "skipped"
      }
    ];
  }
}

class PlaywrightWebResearchProvider implements WebResearchProvider {
  constructor(private readonly _config: AppConfig) {}

  async research(options: WebResearchOptions): Promise<WebResearchSource[]> {
    const limit = Math.max(1, Math.min(5, Math.floor(options.limit ?? 3)));
    try {
      const playwright = await import("playwright");
      return await this.runBrowserResearch(playwright, options, limit);
    } catch (error) {
      return [
        {
          projectId: options.projectId,
          query: options.query,
          title: "Chrome 网页调研失败",
          url: "",
          snippet: "",
          extractedText: "",
          status: "failed",
          error: errorMessage(error)
        }
      ];
    }
  }

  private async runBrowserResearch(
    playwright: PlaywrightModule,
    options: WebResearchOptions,
    limit: number
  ): Promise<WebResearchSource[]> {
    const browser = await playwright.chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROME_BIN || undefined
    });
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    });
    page.setDefaultTimeout(12_000);
    try {
      const searchUrl = new URL("https://www.bing.com/search");
      searchUrl.searchParams.set("q", options.query);
      await page.goto(searchUrl.toString(), { waitUntil: "domcontentloaded" });
      const results = await page
        .locator("li.b_algo")
        .evaluateAll((items, maxItems) => {
          return items.slice(0, Number(maxItems)).map((item) => {
            const titleElement = item.querySelector("h2");
            const linkElement = item.querySelector("h2 a") as HTMLAnchorElement | null;
            const snippetElement = item.querySelector(".b_caption p, p");
            return {
              title: titleElement?.textContent?.trim() ?? "",
              url: linkElement?.href ?? "",
              snippet: snippetElement?.textContent?.trim() ?? ""
            };
          });
        }, limit);

      const sources: WebResearchSource[] = [];
      for (const result of results.filter((item) => item.title && item.url)) {
        let extractedText = "";
        let status: WebResearchSource["status"] = "ok";
        let error: string | undefined;
        try {
          const detail = await browser.newPage();
          detail.setDefaultTimeout(10_000);
          await detail.goto(result.url, { waitUntil: "domcontentloaded", timeout: 10_000 });
          extractedText = compactText((await detail.locator("body").textContent({ timeout: 5_000 })) ?? "").slice(0, 1800);
          await detail.close();
        } catch (detailError) {
          status = "failed";
          error = errorMessage(detailError);
        }
        sources.push({
          projectId: options.projectId,
          query: options.query,
          title: result.title,
          url: result.url,
          snippet: result.snippet,
          extractedText,
          status,
          error
        });
      }

      return sources.length
        ? sources
        : [
            {
              projectId: options.projectId,
              query: options.query,
              title: "未找到可解析的网页结果",
              url: "",
              snippet: "",
              extractedText: "",
              status: "failed",
              error: "Bing 搜索页没有返回可解析结果。"
            }
          ];
    } finally {
      await browser.close();
    }
  }
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
