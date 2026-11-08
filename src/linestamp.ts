/**
 * Prepends a timestamp to every line of a terminal data stream.
 *
 * This runs on the byte stream instead of the rendered buffer for two reasons:
 *
 *  - a line can be split across reads, so "did a newline just arrive" has to be
 *    remembered between chunks;
 *  - programs redraw the current line with a bare `\r` (progress bars, shells
 *    with line editing). Stamping there would print a timestamp and then let
 *    the redraw paint over it, leaving debris on screen.
 *
 * A stamp is only committed once the line actually contains a non-whitespace
 * printable character. Blank lines, lines made only of ANSI escapes/whitespace,
 * and redraw lines are left alone; the stamp is still placed at column 0 even
 * when the line starts with indentation.
 */
type EscapeState = "none" | "esc" | "csi" | "osc" | "osc-esc";

export class LineStamper {
  /** True while this line has not yet earned a stamp and has not been ruled out. */
  private undecided = true;
  /** True until the first printable character of the line. */
  private atLineStart = true;
  /** Text held back while `undecided` is true. */
  private pending = "";
  private escape: EscapeState = "none";
  /** True once the pending buffer contains a space/tab that may be indentation. */
  private pendingHasSpace = false;

  reset(): void {
    this.undecided = true;
    this.atLineStart = true;
    this.pending = "";
    this.escape = "none";
    this.pendingHasSpace = false;
  }

  /**
   * Call when the cursor may sit mid-line — leaving a full-screen app restores
   * the previous screen at an arbitrary column, so a stamp there would land in
   * the middle of existing text.
   */
  markMidLine(): void {
    this.undecided = false;
    this.atLineStart = false;
    this.pending = "";
    this.escape = "none";
    this.pendingHasSpace = false;
  }

  /**
   * @param chunk raw terminal output
   * @param stamp text to insert at each line start (may be empty to only track state)
   */
  process(chunk: string, stamp: string): string {
    if (!chunk) return chunk;
    let out = "";

    // While undecided, everything is held in `pending`; committing puts the
    // stamp at column 0 followed by whatever the line started with.
    const emit = (text: string) => {
      if (this.undecided) this.pending += text;
      else out += text;
    };
    const abandon = () => {
      // Line ended / turned out to be a redraw: emit it verbatim, no stamp.
      out += this.pending;
      this.pending = "";
      this.pendingHasSpace = false;
      this.undecided = false;
    };
    const commit = () => {
      if (!this.undecided) return;
      out += stamp + this.pending;
      this.pending = "";
      this.pendingHasSpace = false;
      this.undecided = false;
    };

    for (const ch of chunk) {
      // ---- ANSI escape sequences never count as line content ----------------
      if (this.escape !== "none") {
        emit(ch);
        switch (this.escape) {
          case "esc":
            this.escape = ch === "[" ? "csi" : ch === "]" ? "osc" : "none";
            break;
          case "csi":
            // CSI ends on any final byte in @..~.
            if (ch >= "@" && ch <= "~") this.escape = "none";
            break;
          case "osc":
            if (ch === "\x07") this.escape = "none";
            else if (ch === "\x1b") this.escape = "osc-esc";
            break;
          case "osc-esc":
            this.escape = ch === "\\" ? "none" : "osc";
            break;
        }
        continue;
      }
      if (ch === "\x1b") {
        emit(ch);
        this.escape = "esc";
        continue;
      }

      if (ch === "\n") {
        emit(ch);
        // No real content arrived: drop the held text as-is. A line that was
        // already committed keeps its stamp and simply ends here.
        if (this.undecided) {
          out += this.pending;
          this.pending = "";
          this.pendingHasSpace = false;
        }
        this.undecided = true;
        this.atLineStart = true;
        continue;
      }

      if (ch === "\r") {
        if (this.atLineStart && this.undecided) {
          // A bare `\r` before any content means the program is repainting this
          // line. Never stamp those.
          abandon();
        }
        emit(ch);
        this.atLineStart = false;
        continue;
      }

      if (ch < " " || ch === "\x7f") {
        emit(ch); // other control characters
        continue;
      }

      if (ch === " " || ch === "\t") {
        // Indentation may be all the line ever contains; hold the decision.
        emit(ch);
        this.pendingHasSpace = true;
        continue;
      }

      commit();
      out += ch;
      this.atLineStart = false;
    }

    // A chunk that ended as pure control/escape data — no printable char, no
    // indentation, and not mid-sequence — must be flushed, not held. ConPTY
    // sends a lone cursor-position query `ESC[6n` that the terminal has to
    // answer; holding it in `pending` forever deadlocks the session (the shell
    // waits for the answer and produces no further output, leaving a blank
    // screen). Space/tab, in contrast, is held: it may be indentation, or it
    // may be an all-whitespace line that should get no stamp.
    if (this.escape === "none" && this.pending !== "" && !this.pendingHasSpace) {
      out += this.pending;
      this.pending = "";
    }
    return out;
  }
}

/** `[13:12:28] ` in dim, restoring intensity without clobbering the current colour. */
export function makeStamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const text = `[${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}]`;
  // SGR 2 / 22 dims without touching fg colour, so a coloured prompt that
  // follows keeps its own colour (a full `\x1b[0m` would reset it).
  return `\x1b[2m${text}\x1b[22m `;
}
