/** Mirrors `src-tauri/src/history.rs::fuzzy_score` so the browser mock behaves
 *  identically to the real backend. */
export function fuzzyScore(query: string, target: string): number | null {
  const q = [...query.toLowerCase()];
  const t = [...target.toLowerCase()];
  if (q.length === 0) return 0;
  if (q.length > t.length) return null;

  let qi = 0;
  let score = 0;
  let last: number | null = null;

  for (let i = 0; i < t.length; i++) {
    if (qi >= q.length) break;
    if (t[i] === q[qi]) {
      score += 10;
      if (last !== null) {
        if (i === last + 1) score += 15;
        else score -= Math.min(i - last - 1, 20);
      } else {
        score -= Math.min(i, 20);
      }
      last = i;
      qi++;
    }
  }

  if (qi < q.length) return null;

  const qs = q.join("");
  const ts = t.join("");
  if (ts.startsWith(qs)) score += 60;
  score -= Math.min(t.length, 80) / 4;
  return score;
}
