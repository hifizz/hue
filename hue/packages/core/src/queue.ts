/** 极小的异步队列：把并发任务产生的事件汇成一条流。 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: Array<(r: IteratorResult<T>) => void> = []
  private closed = false
  push(item: T): void {
    const w = this.waiters.shift()
    if (w) w({ value: item, done: false })
    else this.items.push(item)
  }
  close(): void {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise(r => this.waiters.push(r))
      },
    }
  }
}
