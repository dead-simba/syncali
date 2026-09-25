export interface PendingSyncWork {
  push: boolean;
  pullTargetCursor: number | null;
}

export class PendingSyncWorkQueue {
  private readonly pendingWork: PendingSyncWork = {
    push: false,
    pullTargetCursor: null,
  };

  get push(): boolean {
    return this.pendingWork.push;
  }

  get pullTargetCursor(): number | null {
    return this.pendingWork.pullTargetCursor;
  }

  requestPush(): void {
    this.pendingWork.push = true;
  }

  requestPull(targetCursor: number | null): void {
    if (targetCursor === null) {
      this.pendingWork.pullTargetCursor ??= 0;
      return;
    }

    this.pendingWork.pullTargetCursor = Math.max(
      this.pendingWork.pullTargetCursor ?? 0,
      targetCursor,
    );
  }

  hasPendingWork(): boolean {
    return this.pendingWork.push || this.pendingWork.pullTargetCursor !== null;
  }

  /**
   * Whether there is work that can run now. With `holdPush`, a requested push
   * does not count: it is waiting for something else, such as a backoff.
   */
  hasRunnableWork(options: { holdPush: boolean }): boolean {
    return (
      (this.pendingWork.push && !options.holdPush) ||
      this.pendingWork.pullTargetCursor !== null
    );
  }

  /**
   * Take everything that can run now. A held push stays requested, so it runs
   * on the next call that does not hold it.
   */
  takePendingWork(options: { holdPush: boolean } = { holdPush: false }): PendingSyncWork {
    const work = {
      push: this.pendingWork.push && !options.holdPush,
      pullTargetCursor: this.pendingWork.pullTargetCursor,
    };
    this.pendingWork.push = this.pendingWork.push && options.holdPush;
    this.pendingWork.pullTargetCursor = null;
    return work;
  }

  clear(): void {
    this.pendingWork.push = false;
    this.pendingWork.pullTargetCursor = null;
  }
}
