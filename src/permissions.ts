export type PermAnswer = "yes" | "no" | "always";

/** Asks the UI for a decision on a dangerous action. */
export type PermissionRequester = (summary: string) => Promise<PermAnswer>;

/**
 * Gates dangerous tool calls behind a UI prompt, remembering "always"
 * approvals for the rest of the session. UI-agnostic: the requester is wired
 * at startup (Ink store, or a readline prompt in headless mode).
 */
export class PermissionManager {
  private allowed = new Set<string>();
  private requester: PermissionRequester | null = null;

  constructor(private skipAll: boolean) {}

  setSkipAll(value: boolean): void {
    this.skipAll = value;
  }

  setRequester(requester: PermissionRequester): void {
    this.requester = requester;
  }

  /**
   * @param key  allowlist key — same key => one "always" covers them all
   * @param summary  human-readable description of the action
   */
  async check(key: string, summary: string): Promise<boolean> {
    if (this.skipAll) return true;
    if (this.allowed.has(key)) return true;
    if (!this.requester) return false;

    const answer = await this.requester(summary);
    if (answer === "always") {
      this.allowed.add(key);
      return true;
    }
    return answer === "yes";
  }
}
