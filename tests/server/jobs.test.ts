import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db.ts';
import { TransientError } from '../../src/server/errors.ts';
import { canTransition, JobQueue, MAX_ATTEMPTS, type JobContext } from '../../src/server/jobs.ts';
import { waitFor } from './helpers.ts';

const queues: JobQueue[] = [];
afterEach(async () => {
  for (const q of queues.splice(0)) await q.stop();
});

function makeQueue(run: (ctx: JobContext) => Promise<void>, cleanup?: () => Promise<void>) {
  const db = openDb(':memory:');
  const q = new JobQueue(
    db,
    { upload: { run: (_j, ctx) => run(ctx), cleanup }, index: { run: async () => undefined } },
    { concurrency: () => 1, canRun: () => true, backoffMs: () => 10, tickMs: 10 },
  );
  queues.push(q);
  return { q, db };
}

const until = (signal: AbortSignal) =>
  new Promise<void>((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));

describe('job state machine', () => {
  it('only allows documented transitions', () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('done', 'queued')).toBe(false);
    expect(canTransition('cancelled', 'running')).toBe(false);
    expect(canTransition('paused', 'running')).toBe(false);
    expect(canTransition('failed', 'queued')).toBe(true);
  });

  it('runs to done and reports progress', async () => {
    const { q } = makeQueue(async (ctx) => {
      ctx.progress(50, 100);
      ctx.progress(100, 100);
    });
    q.start();
    const job = q.create('upload', 'r', 'f', '/f', {}, 100);
    await waitFor(() => q.get(job.id)?.state === 'done');
    expect(q.get(job.id)).toMatchObject({ progress: 100, total: 100, error: null });
  });

  it('retries transient failures with backoff, then fails permanently', async () => {
    let calls = 0;
    const { q } = makeQueue(async () => {
      calls++;
      throw new TransientError('network down');
    });
    q.start();
    const job = q.create('upload', 'r', 'f', '/f', {});
    await waitFor(() => q.get(job.id)?.state === 'failed');
    expect(calls).toBe(MAX_ATTEMPTS);
    expect(q.get(job.id)?.error).toMatch(/network down/);
  });

  it('fails immediately on non-transient errors and can be retried', async () => {
    let ok = false;
    const { q } = makeQueue(async () => {
      if (!ok) throw new Error('bad input');
    });
    q.start();
    const job = q.create('upload', 'r', 'f', '/f', {});
    await waitFor(() => q.get(job.id)?.state === 'failed');
    ok = true;
    q.retry(job.id);
    await waitFor(() => q.get(job.id)?.state === 'done');
  });

  it('pauses, resumes and cancels a running job', async () => {
    let started = 0;
    let cleaned = false;
    const { q } = makeQueue(
      async (ctx) => {
        started++;
        await until(ctx.signal);
      },
      async () => {
        cleaned = true;
      },
    );
    q.start();
    const job = q.create('upload', 'r', 'f', '/f', {});
    await waitFor(() => q.get(job.id)?.state === 'running');
    q.pause(job.id);
    expect(q.get(job.id)?.state).toBe('paused');
    q.resume(job.id);
    await waitFor(() => started === 2 && q.get(job.id)?.state === 'running');
    await q.cancel(job.id);
    expect(q.get(job.id)?.state).toBe('cancelled');
    expect(cleaned).toBe(true);
    expect(() => q.resume(job.id)).toThrow(/cannot move a cancelled job/);
  });

  it('persists payload updates and re-queues running jobs on recovery', async () => {
    const { q, db } = makeQueue(async (ctx) => {
      ctx.savePayload({ step: 2 });
      await until(ctx.signal);
    });
    q.start();
    const job = q.create('upload', 'r', 'f', '/f', { step: 1 });
    await waitFor(() => q.payload(job.id).step === 2);
    // A second queue on the same DB simulates the process restarting.
    const q2 = new JobQueue(
      db,
      { upload: { run: async () => undefined }, index: { run: async () => undefined } },
      { concurrency: () => 1, canRun: () => true },
    );
    expect(q2.recover()).toBe(1);
    expect(q2.get(job.id)?.state).toBe('queued');
    expect(q2.payload(job.id)).toEqual({ step: 2 });
  });

  it('respects the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const { q } = makeQueue(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
    });
    q.start();
    const ids = [1, 2, 3].map((i) => q.create('upload', 'r', `f${i}`, `/f${i}`, {}).id);
    await waitFor(() => ids.every((id) => q.get(id)?.state === 'done'));
    expect(peak).toBe(1);
  });
});
