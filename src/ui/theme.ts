/**
 * Centralized palette. Values are Ink color names/hex usable directly in
 * <Text color=…>. Ink auto-disables color on non-TTY / NO_COLOR, so callers
 * don't need to branch.
 */
export const theme = {
  accent: "magenta",
  user: "green",
  dim: "gray",
  success: "green",
  error: "red",
  warn: "yellow",
  tool: "cyan",
  border: "gray",
} as const;

export const noColor =
  Boolean(process.env.NO_COLOR) || !process.stdout.isTTY;
