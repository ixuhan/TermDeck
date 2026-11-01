import { createMockIpc } from "./mock";
import { createTauriIpc } from "./tauri";
import type { Ipc } from "./types";

export type { Ipc, PersistedWorkspace } from "./types";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const ipc: Ipc = inTauri() ? createTauriIpc() : createMockIpc();
