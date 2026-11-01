/**
 * Best-effort CWD tracking for shells that never emit OSC 7 (PowerShell, cmd).
 * We only follow explicit directory-change commands typed through the command
 * bar; anything ambiguous returns null so we never persist a wrong path.
 */
const CD_PATTERN = /^\s*(?:cd|chdir|pushd|set-location|sl)\s+(.+?)\s*$/i;

function normalize(path: string, sep: string): string {
  const driveMatch = /^([A-Za-z]:)/.exec(path);
  const drive = driveMatch ? driveMatch[1] : "";
  const rest = driveMatch ? path.slice(2) : path;
  const absolute = rest.startsWith(sep);

  const stack: string[] = [];
  for (const part of rest.split(sep)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0) stack.pop();
      else if (!absolute) stack.push("..");
      continue;
    }
    stack.push(part);
  }

  const joined = stack.join(sep);
  if (drive) return `${drive}${sep}${joined}`;
  return absolute ? `${sep}${joined}` : joined;
}

export function trackCwd(current: string, command: string): string | null {
  const m = CD_PATTERN.exec(command);
  if (!m) return null;

  let arg = m[1].trim().replace(/^["']|["']$/g, "");
  if (!arg) return null;
  // `cd -`, flags, or wildcards: too ambiguous to persist.
  if (arg === "-" || arg.startsWith("-") || /[*?]/.test(arg)) return null;
  if (arg.startsWith("~")) return null;

  const isPosixTarget = arg.startsWith("/");
  const isPosixBase = !/^[A-Za-z]:/.test(current);
  const sep = isPosixTarget || isPosixBase ? "/" : "\\";

  if (isPosixTarget) return normalize(arg, "/");

  const looksAbsolute = /^[A-Za-z]:/.test(arg) || arg.startsWith("\\");
  if (looksAbsolute) return normalize(arg, "\\");

  if (!current) return null;
  return normalize(`${current}${current.endsWith(sep) ? "" : sep}${arg}`, sep);
}
