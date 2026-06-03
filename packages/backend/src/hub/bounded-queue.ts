/**
 * BoundedQueue — fixed-capacity async channel providing backpressure (T-02).
 *
 * This is the hub's "parking lot with a Lot-Full sign". It decouples a fast
 * producer (a source connector) from slower consumers (the router/dispatch
 * loop) without letting memory grow without bound:
 *
 *   - enqueue() resolves immediately while there is room; once the buffer is
 *     full it AWAITS until a consumer frees a slot — this await is the
 *     backpressure that throttles the producer.
 *   - dequeue() resolves immediately when an item is buffered; otherwise it
 *     awaits until something is enqueued (or the queue is closed).
 *
 * FIFO ordering is preserved. Producers waiting on a full queue are released
 * in arrival order as slots free up.
 */
export class BoundedQueue<T> {
  private readonly buffer: T[] = [];
  /** Producers parked because the buffer is full, in arrival order. */
  private readonly producerWaiters: Array<() => void> = [];
  /** Consumers parked because the buffer is empty, in arrival order. */
  private readonly consumerWaiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`BoundedQueue capacity must be a positive integer, got ${capacity}`);
    }
  }

  get size(): number {
    return this.buffer.length;
  }

  get isFull(): boolean {
    return this.buffer.length >= this.capacity;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Number of producers currently blocked on backpressure (for tests/metrics). */
  get waitingProducers(): number {
    return this.producerWaiters.length;
  }

  /**
   * Add an item. Resolves once buffered (or handed directly to a waiting
   * consumer). Blocks while the queue is full. Throws if the queue is closed.
   */
  async enqueue(item: T): Promise<void> {
    if (this.closed) throw new Error('Cannot enqueue on a closed BoundedQueue');

    // Hand off directly to a waiting consumer — bypasses the buffer entirely.
    const consumer = this.consumerWaiters.shift();
    if (consumer) {
      consumer({ value: item, done: false });
      return;
    }

    // Backpressure: wait until there is room.
    while (this.isFull && !this.closed) {
      await new Promise<void>((resolve) => this.producerWaiters.push(resolve));
    }
    if (this.closed) throw new Error('Cannot enqueue on a closed BoundedQueue');

    this.buffer.push(item);
  }

  /**
   * Take the next item. Resolves `{ value, done: false }` when one is
   * available; awaits when empty. Once the queue is closed AND drained,
   * resolves `{ value: undefined, done: true }`.
   */
  async dequeue(): Promise<IteratorResult<T>> {
    if (this.buffer.length > 0) {
      const value = this.buffer.shift() as T;
      this.releaseOneProducer(); // a slot just freed up
      return { value, done: false };
    }

    if (this.closed) {
      return { value: undefined as unknown as T, done: true };
    }

    return new Promise<IteratorResult<T>>((resolve) => this.consumerWaiters.push(resolve));
  }

  /**
   * Close the queue: no further enqueues. Waiting consumers are completed with
   * `done: true`; blocked producers are woken so they observe the closed state.
   * Items already buffered remain dequeue-able until drained.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    while (this.consumerWaiters.length > 0) {
      const consumer = this.consumerWaiters.shift()!;
      consumer({ value: undefined as unknown as T, done: true });
    }
    while (this.producerWaiters.length > 0) {
      const producer = this.producerWaiters.shift()!;
      producer();
    }
  }

  private releaseOneProducer(): void {
    const next = this.producerWaiters.shift();
    if (next) next();
  }

  /** Drain the queue as an async iterable until it is closed. */
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const result = await this.dequeue();
      if (result.done) return;
      yield result.value;
    }
  }
}
