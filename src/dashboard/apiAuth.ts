import type { IncomingMessage } from "node:http";

export const DEFAULT_KATO_API_TOKEN = "LiuTao0.1";

export function getConfiguredApiToken(): string {
  return process.env.KATO_API_TOKEN?.trim() || process.env.XHS_API_TOKEN?.trim() || DEFAULT_KATO_API_TOKEN;
}

export function getAcceptedApiTokens(): string[] {
  const values = [process.env.KATO_API_TOKEN?.trim(), process.env.XHS_API_TOKEN?.trim()].filter(Boolean) as string[];
  return values.length ? [...new Set(values)] : [DEFAULT_KATO_API_TOKEN];
}

export function getRequestApiToken(req: IncomingMessage): string {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice("bearer ".length).trim();
  }
  const apiKey = req.headers["x-api-key"];
  return Array.isArray(apiKey) ? String(apiKey[0] ?? "").trim() : String(apiKey ?? "").trim();
}

export function isAuthorizedRequest(req: IncomingMessage): boolean {
  return isValidApiToken(getRequestApiToken(req));
}

export function isValidApiToken(token: string): boolean {
  return Boolean(token) && getAcceptedApiTokens().includes(token);
}
