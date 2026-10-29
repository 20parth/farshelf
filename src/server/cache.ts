// In-memory LRU cache of fixed-size blocks. Streaming never writes file contents to disk.
export class BlockCache {
  private readonly map = new Map<string, Uint8Array>();
  private bytes = 0;
  private limit: number;

  constructor(limitBytes: number) {
    this.limit = limitBytes;
  }

  get(key: string): Uint8Array | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: Uint8Array): void {
    if (value.length > this.limit) return;
    const old = this.map.get(key);
    if (old) {
      this.bytes -= old.length;
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.bytes += value.length;
    this.evict();
  }

  /** Drop every block whose key starts with `prefix` (a file or a whole remote). */
  invalidate(prefix: string): void {
    for (const [k, v] of this.map) {
      if (k.startsWith(prefix)) {
        this.map.delete(k);
        this.bytes -= v.length;
      }
    }
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  setLimit(limitBytes: number): void {
    this.limit = limitBytes;
    this.evict();
  }

  stats() {
    return { bytes: this.bytes, limit: this.limit, entries: this.map.size };
  }

  private evict(): void {
    while (this.bytes > this.limit) {
      const first = this.map.keys().next();
      if (first.done) break;
      this.bytes -= this.map.get(first.value)!.length;
      this.map.delete(first.value);
    }
  }
}
