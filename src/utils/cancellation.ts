export class CancellationToken {
  private _abortController: AbortController;

  constructor() {
    this._abortController = new AbortController();
  }

  get isCancelled(): boolean {
    return this._abortController.signal.aborted;
  }

  get signal(): AbortSignal {
    return this._abortController.signal;
  }

  cancel(): void {
    this._abortController.abort();
  }

  throwIfCancelled(): void {
    if (this.isCancelled) {
      throw new CancellationError();
    }
  }

  onCancel(callback: () => void): void {
    this._abortController.signal.addEventListener('abort', callback, { once: true });
  }
}

export class CancellationError extends Error {
  constructor() {
    super('Operation cancelled');
    this.name = 'CancellationError';
  }
}
