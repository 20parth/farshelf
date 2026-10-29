/** Errors with an HTTP status and a message that is safe and useful to show to users. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.status = status;
    this.code = code;
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super(404, 'not_found', `${what} was not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'conflict', message);
  }
}

export class LockedError extends AppError {
  constructor(remoteName: string) {
    super(
      423,
      'locked',
      `"${remoteName}" is encrypted and locked. Unlock it with your passphrase or recovery key.`,
    );
  }
}

/** A failure that may succeed if retried later (network down, rate limit, 5xx). */
export class TransientError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(503, 'unavailable', message, options);
  }
}

export function isTransient(err: unknown): boolean {
  if (err instanceof TransientError) return true;
  if (err instanceof AppError) return false;
  const code =
    (err as { code?: string; cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
  return (
    err instanceof TypeError /* fetch failed */ ||
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET'].includes(
      code ?? '',
    )
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
