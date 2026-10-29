export interface RemoteStat {
  name: string;
  kind: 'file' | 'dir';
  size: number;
  /** milliseconds since epoch */
  mtime: number;
}

/** JSON-serialisable state of an in-progress upload, persisted in the job so it survives restarts. */
export type UploadState = Record<string, unknown>;

/**
 * Storage backend. All paths are absolute POSIX-style paths relative to the backend root ("/" = root).
 * Implementations must not follow paths outside their root.
 */
export interface Backend {
  readonly kind: string;
  /** True if uploads can continue from a confirmed offset after an interruption. */
  readonly resumable: boolean;
  list(path: string): Promise<RemoteStat[]>;
  stat(path: string): Promise<RemoteStat | null>;
  /** Read bytes [start, end). */
  read(path: string, start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
  mkdir(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  /** Permanently delete a file or a directory tree. */
  remove(path: string): Promise<void>;
  /** Start an upload that will create or replace `path` with exactly `size` bytes. */
  beginUpload(path: string, size: number): Promise<UploadState>;
  /** Bytes the backend has durably received for this upload. */
  uploadedOffset(state: UploadState): Promise<number>;
  /** Send bytes at `offset`. When `offset + data.length === size` the upload is finalised. */
  uploadChunk(state: UploadState, offset: number, data: Uint8Array, signal?: AbortSignal): Promise<void>;
  /** Optional preferred chunk size (bytes); must be honoured for all non-final chunks. */
  readonly chunkSize: number;
  abortUpload(state: UploadState): Promise<void>;
  /** Non-resumable backends upload the whole body in one request instead of using chunks. */
  putStream?(path: string, size: number, body: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<void>;
  /** Human-readable location for the UI. */
  describe(): string;
}
