import pc from "picocolors";

export type Ask = (question: string) => Promise<string>;

/**
 * Gates dangerous tool calls behind an interactive prompt, remembering
 * "always" approvals for the rest of the session.
 */
export class PermissionManager {
  private allowed = new Set<string>();
  private ask: Ask | null = null;

  constructor(private skipAll: boolean) {}

  setSkipAll(value: boolean): void {
    this.skipAll = value;
  }

  /** Wire up the shared readline prompt once the REPL owns it. */
  setAsk(ask: Ask): void {
    this.ask = ask;
  }

  /**
   * @param key  allowlist key — same key => one "always" covers them all
   * @param summary  human-readable description of the action
   */
  async check(key: string, summary: string): Promise<boolean> {
    if (this.skipAll) return true;
    if (this.allowed.has(key)) return true;
    if (!this.ask) return false;

    process.stdout.write(
      pc.yellow("\n  permission required: ") + pc.bold(summary) + "\n"
    );
    const answer = (
      await this.ask(pc.dim("  allow? [y]es / [n]o / [a]lways this kind: "))
    )
      .trim()
      .toLowerCase();

    if (answer === "a" || answer === "always") {
      this.allowed.add(key);
      return true;
    }
    return answer === "y" || answer === "yes";
  }
}
