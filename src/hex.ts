/** Hex input parsing shared by the command bar and tests. */

/** Parses "41 42 0A", "41420A" or "0x41,0x42" into bytes; null when invalid. */
export function parseHexInput(input: string): number[] | null {
  const cleaned = input.replace(/0x/gi, "").replace(/[\s,;]/g, "");
  if (cleaned === "") return [];
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) return null;
  if (cleaned.length % 2 !== 0) return null;
  const out: number[] = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    out.push(parseInt(cleaned.slice(i, i + 2), 16));
  }
  return out;
}

/** "48 65 6C 6C 6F" — used when echoing a hex send. */
export function toHexPreview(bytes: number[]): string {
  return bytes
    .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");
}
