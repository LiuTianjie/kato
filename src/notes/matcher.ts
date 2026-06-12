import type { Note, XhsPost } from "../domain/types.js";

export function matchBestNote(post: XhsPost, notes: Note[]): { note: Note | null; score: number } {
  let best: { note: Note | null; score: number } = { note: null, score: 0 };
  const text = normalize(`${post.title} ${post.snippet}`);

  for (const note of notes) {
    const keywordScore = note.keywords.reduce(
      (sum, keyword) => sum + (text.includes(normalize(keyword)) ? 3 : 0),
      0
    );
    const scenarioScore = note.scenarios.reduce(
      (sum, scenario) => sum + overlapScore(text, normalize(scenario)),
      0
    );
    const summaryScore = overlapScore(text, normalize(note.summary));
    const score = keywordScore + scenarioScore + summaryScore;

    if (score > best.score) {
      best = { note, score };
    }
  }

  return best.score > 0 ? best : { note: notes[0] ?? null, score: 0 };
}

function overlapScore(a: string, b: string): number {
  const tokens = [...new Set(splitTokens(b))];
  return tokens.reduce((sum, token) => sum + (token.length > 1 && a.includes(token) ? 1 : 0), 0);
}

function splitTokens(value: string): string[] {
  return value.split(/[^\p{Letter}\p{Number}]+/u).filter(Boolean);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}
