/** A queued send waits for its own session to enter a run before draining again. */
export class ComposerQueueAdmission {
  private sending = new Set<string>();
  private awaitingRun = new Set<string>();
  private blocked = new Set<string>();

  canSend(sessionId: string) {
    return !this.sending.has(sessionId) && !this.awaitingRun.has(sessionId) && !this.blocked.has(sessionId);
  }

  isSending(sessionId: string) {
    return this.sending.has(sessionId);
  }

  begin(sessionId: string) {
    if (!this.canSend(sessionId)) return false;
    this.sending.add(sessionId);
    this.awaitingRun.add(sessionId);
    return true;
  }

  observeRun(sessionId: string) {
    this.awaitingRun.delete(sessionId);
  }

  defer(sessionId: string) {
    this.awaitingRun.delete(sessionId);
    this.blocked.add(sessionId);
  }

  retry(sessionId: string) {
    this.blocked.delete(sessionId);
  }

  settle(sessionId: string) {
    this.sending.delete(sessionId);
  }
}
