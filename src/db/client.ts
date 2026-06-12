import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../config.js";

export type Db = DatabaseSync;

export function openDb(config: AppConfig): Db {
  mkdirSync(path.dirname(config.sqlitePath), { recursive: true });
  return new DatabaseSync(config.sqlitePath);
}

export function row<T>(value: unknown): T | null {
  return (value ?? null) as T | null;
}

export function rows<T>(value: unknown[]): T[] {
  return value as T[];
}
