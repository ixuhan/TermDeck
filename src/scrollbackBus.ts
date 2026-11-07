/**
 * Live screen contents, one snapshot provider per session.
 *
 * The terminal could only save on unmount, but a window close does not unmount
 * React. The app's close handler asks every provider for a last snapshot so the
 * final seconds of output are not lost.
 */
const providers = new Map<string, () => string>();

export const scrollbacks = {
  register(key: string, snapshot: () => string) {
    providers.set(key, snapshot);
  },

  unregister(key: string) {
    providers.delete(key);
  },

  /** Called before the window closes; saves whatever is currently on screen. */
  async flush(save: (key: string, data: string) => Promise<void>) {
    for (const [key, snapshot] of [...providers]) {
      try {
        const data = snapshot();
        if (data) await save(key, data);
      } catch {
        /* a broken terminal must not block shutdown */
      }
    }
  },
};
