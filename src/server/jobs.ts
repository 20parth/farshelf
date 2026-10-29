// Persistent background jobs with an explicit state machine. Survives restarts: running jobs go back to queued.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { JobInfo, JobState } from '../shared/schemas.ts';
import type { Db } from './db.ts';
import { AppError, errorMessage, isTransient, NotFoundError } from './errors.ts';

export type JobKind = JobInfo['kind'];

const TRANSITIONS: Record<JobState, JobState[]> = {
  queued: ['running', 'paused', 'cancelled'],
  running: ['done', 'failed', 'paused', 'cancelled', 'queued'],
  paused: ['queued', 'cancelled'],
  failed: ['queued', 'cancelled'],
  done: [],
  cancelled: [],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export const MAX_ATTEMPTS = 10;

export interface JobContext {
  signal: AbortSignal;
  payload: Record<string, unknown>;
  savePayload(payload: Record<string, unknown>): void;
  progress(done: number, total?: number): void;
}

export interface JobHandler {
  run(job: JobInfo, ctx: JobContext): Promise<void>;
  /** Clean-up after cancel (delete spool files, abort remote sessions). */
  cleanup?(job: JobInfo, payload: Record<string, unknown>): Promise<void>;
}

interface Row {
  id: string;
  kind: JobKind;
  remote_id: string;
  state: JobState;
  label: string;
  path: string;
  payload: string;
  progress: number;
  total: number;
  error: string | null;
  attempts: number;
  next_run_at: number;
  created_at: number;
  updated_at: number;
}

interface Running {
  controller: AbortController;
  reason?: 'pause' | 'cancel' | 'shutdown';
  samples: { t: number; b: number }[];
}

export interface JobQueueOptions {
  concurrency: (kind: JobKind) => number;
  /** e.g. false while the job's remote is locked */
  canRun: (job: JobInfo) => boolean;
  backoffMs?: (attempt: number) => number;
  tickMs?: number;
}

export class JobQueue extends EventEmitter {
  private readonly db: Db;
  private readonly handlers: Record<JobKind, JobHandler>;
  private readonly opts: JobQueueOptions;
  private readonly running = new Map<string, Running>();
  private readonly lastEmit = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(db: Db, handlers: Record<JobKind, JobHandler>, opts: JobQueueOptions) {
    super();
    this.db = db;
    this.handlers = handlers;
    this.opts = opts;
  }

  /** Called once at start-up: anything that was running when the process died is re-queued. */
  recover(): number {
    const r = this.db.prepare(`update jobs set state = 'queued', updated_at = ? where state = 'running'`).run(Date.now());
    return Number(r.changes);
  }

  start(): void {
    this.stopped = false;
    this.timer ??= setInterval(() => void this.tick(), this.opts.tickMs ?? 500);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const [id, r] of this.running) {
      r.reason = 'shutdown';
      r.controller.abort();
      if (this.db.isOpen && this.row(id)?.state === 'running') this.setState(id, 'queued', {});
    }
    this.running.clear();
  }

  create(kind: JobKind, remoteId: string, label: string, path: string, payload: Record<string, unknown>, total = 0): JobInfo {
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `insert into jobs (id, kind, remote_id, state, label, path, payload, progress, total, created_at, updated_at) values (?, ?, ?, 'queued', ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(id, kind, remoteId, label, path, JSON.stringify(payload), total, now, now);
    const job = this.get(id)!;
    this.emit('job', job);
    if (!this.stopped) queueMicrotask(() => void this.tick());
    return job;
  }

  private row(id: string): Row | undefined {
    return this.db.prepare('select * from jobs where id = ?').get(id) as Row | undefined;
  }

  private toInfo(r: Row): JobInfo {
    return {
      id: r.id,
      kind: r.kind,
      remoteId: r.remote_id,
      state: r.state,
      label: r.label,
      path: r.path,
      progress: r.progress,
      total: r.total,
      rate: this.rate(r.id),
      error: r.error,
      attempts: r.attempts,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  get(id: string): JobInfo | null {
    const r = this.row(id);
    return r ? this.toInfo(r) : null;
  }

  payload(id: string): Record<string, unknown> {
    const r = this.row(id);
    if (!r) throw new NotFoundError('job');
    return JSON.parse(r.payload);
  }

  list(filter: { remoteId?: string; states?: JobState[] } = {}): JobInfo[] {
    const rows = this.db.prepare('select * from jobs order by created_at desc limit 500').all() as unknown as Row[];
    return rows
      .filter((r) => (!filter.remoteId || r.remote_id === filter.remoteId) && (!filter.states || filter.states.includes(r.state)))
      .map((r) => this.toInfo(r));
  }

  private setState(id: string, to: JobState, patch: { error?: string | null; attempts?: number; nextRunAt?: number }): JobInfo {
    const r = this.row(id);
    if (!r) throw new NotFoundError('job');
    if (!canTransition(r.state, to)) throw new AppError(409, 'bad_transition', `cannot move a ${r.state} job to ${to}`);
    this.db
      .prepare('update jobs set state = ?, error = ?, attempts = ?, next_run_at = ?, updated_at = ? where id = ?')
      .run(
        to,
        patch.error === undefined ? r.error : patch.error,
        patch.attempts ?? r.attempts,
        patch.nextRunAt ?? 0,
        Date.now(),
        id,
      );
    const info = this.get(id)!;
    this.emit('job', info);
    return info;
  }

  pause(id: string): JobInfo {
    const run = this.running.get(id);
    if (run) {
      run.reason = 'pause';
      run.controller.abort();
      this.running.delete(id);
    }
    return this.setState(id, 'paused', {});
  }

  resume(id: string): JobInfo {
    return this.setState(id, 'queued', { error: null });
  }

  retry(id: string): JobInfo {
    return this.setState(id, 'queued', { error: null, attempts: 0 });
  }

  async cancel(id: string): Promise<JobInfo> {
    const run = this.running.get(id);
    if (run) {
      run.reason = 'cancel';
      run.controller.abort();
      this.running.delete(id);
    }
    const info = this.setState(id, 'cancelled', {});
    const handler = this.handlers[info.kind];
    await handler.cleanup?.(info, this.payload(id)).catch(() => undefined);
    return info;
  }

  clearFinished(): number {
    const r = this.db.prepare(`delete from jobs where state in ('done', 'cancelled')`).run();
    this.emit('jobs-cleared');
    return Number(r.changes);
  }

  deleteForRemote(remoteId: string): void {
    for (const j of this.list({ remoteId })) {
      const run = this.running.get(j.id);
      if (run) {
        run.reason = 'cancel';
        run.controller.abort();
        this.running.delete(j.id);
      }
    }
    this.db.prepare('delete from jobs where remote_id = ?').run(remoteId);
  }

  private rate(id: string): number {
    const s = this.running.get(id)?.samples;
    if (!s || s.length < 2) return 0;
    const a = s[0]!;
    const b = s[s.length - 1]!;
    return b.t > a.t ? ((b.b - a.b) / (b.t - a.t)) * 1000 : 0;
  }

  async tick(): Promise<void> {
    if (this.ticking || this.stopped || !this.db.isOpen) return;
    this.ticking = true;
    try {
      const queued = this.db
        .prepare(`select * from jobs where state = 'queued' and next_run_at <= ? order by created_at`)
        .all(Date.now()) as unknown as Row[];
      for (const r of queued) {
        const running = [...this.running.keys()].map((id) => this.row(id)?.kind);
        if (running.filter((k) => k === r.kind).length >= this.opts.concurrency(r.kind)) continue;
        const info = this.toInfo(r);
        if (!this.opts.canRun(info)) continue;
        this.launch(info);
      }
    } finally {
      this.ticking = false;
    }
  }

  private launch(job: JobInfo): void {
    const controller = new AbortController();
    const run: Running = { controller, samples: [] };
    this.running.set(job.id, run);
    const started = this.setState(job.id, 'running', { error: null });
    const ctx: JobContext = {
      signal: controller.signal,
      payload: this.payload(job.id),
      savePayload: (p) => {
        ctx.payload = p;
        this.db.prepare('update jobs set payload = ?, updated_at = ? where id = ?').run(JSON.stringify(p), Date.now(), job.id);
      },
      progress: (done, total) => {
        if (controller.signal.aborted) return;
        const now = Date.now();
        run.samples.push({ t: now, b: done });
        while (run.samples.length > 2 && now - run.samples[0]!.t > 5000) run.samples.shift();
        if (total !== undefined) this.db.prepare('update jobs set progress = ?, total = ?, updated_at = ? where id = ?').run(done, total, now, job.id);
        else this.db.prepare('update jobs set progress = ?, updated_at = ? where id = ?').run(done, now, job.id);
        if (now - (this.lastEmit.get(job.id) ?? 0) > 250) {
          this.lastEmit.set(job.id, now);
          this.emit('job', this.get(job.id));
        }
      },
    };
    this.handlers[job.kind]
      .run(started, ctx)
      .then(() => {
        if (controller.signal.aborted || this.stopped) return;
        this.running.delete(job.id);
        this.setState(job.id, 'done', { error: null });
      })
      .catch((err) => {
        if (run.reason || this.stopped || !this.db.isOpen) return; // paused, cancelled or shutting down: state already set
        this.running.delete(job.id);
        const attempts = (this.row(job.id)?.attempts ?? 0) + 1;
        if (isTransient(err) && attempts < MAX_ATTEMPTS) {
          const delay = this.opts.backoffMs?.(attempts) ?? Math.min(300_000, 2000 * 2 ** (attempts - 1));
          this.setState(job.id, 'queued', {
            error: `${errorMessage(err)} (retry ${attempts}/${MAX_ATTEMPTS - 1} in ${Math.round(delay / 1000)}s)`,
            attempts,
            nextRunAt: Date.now() + delay,
          });
        } else {
          this.setState(job.id, 'failed', { error: errorMessage(err), attempts });
        }
        this.emit('job-error', job, err);
      })
      .finally(() => queueMicrotask(() => void this.tick()));
  }
}
