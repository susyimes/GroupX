export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  #closed = false;
  #failure: unknown;

  get length(): number {
    return this.#items.length;
  }

  get closed(): boolean {
    return this.#closed;
  }

  push(item: T): boolean {
    if (this.#closed) {
      return false;
    }
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ value: item, done: false });
    } else {
      this.#items.push(item);
    }
    return true;
  }

  end(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.#items.length > 0) {
      return { value: this.#items.shift() as T, done: false };
    }
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    if (this.#closed) {
      return { value: undefined, done: true };
    }
    return await new Promise<IteratorResult<T>>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}
