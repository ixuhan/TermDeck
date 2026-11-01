/** Mirrors `mask_secrets` in `src-tauri/src/history.rs` so the browser mock
 *  stores exactly what the real backend would. */
const VALUE_FLAGS = ["--password", "--passwd", "--token", "--secret", "--api-key", "--apikey"];
const KEY_HINTS = ["PASSWORD", "PASSWD", "TOKEN", "SECRET", "API_KEY"];

export function maskSecrets(command: string): string {
  const tokens = command.split(" ");
  const out: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const lower = tok.toLowerCase();

    const eq = tok.indexOf("=");
    if (eq >= 0) {
      const key = tok.slice(0, eq);
      const keyUpper = key.toUpperCase();
      if (
        VALUE_FLAGS.includes(key.toLowerCase()) ||
        KEY_HINTS.some((h) => keyUpper.includes(h))
      ) {
        out.push(`${key}=***`);
        continue;
      }
    }

    if (VALUE_FLAGS.includes(lower) && i + 1 < tokens.length) {
      out.push(tok, "***");
      i++;
      continue;
    }

    out.push(tok);
  }

  return out.join(" ");
}
