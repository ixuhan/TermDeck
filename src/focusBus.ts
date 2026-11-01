/** Imperative focus bridge: the command bar and the terminal both need to be
 *  able to hand focus to one another from outside their own render tree. */
export const ui = {
  focusCommand: () => {},
  focusTerminal: () => {},
  fillCommand: (_text: string) => {},
};
