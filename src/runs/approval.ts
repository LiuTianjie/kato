import type { Db } from "../db/client.js";
import type { QueueStatus } from "../domain/types.js";

const ALLOWED_STATUSES = new Set<QueueStatus>([
  "new",
  "drafted",
  "posted_by_user",
  "posted_via_mcp",
  "skipped"
]);

export function markInteraction(db: Db, interactionId: number, status: string): number {
  if (!ALLOWED_STATUSES.has(status as QueueStatus)) {
    throw new Error(`Invalid status: ${status}`);
  }

  return db
    .prepare("UPDATE interactions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(status, interactionId).changes;
}
