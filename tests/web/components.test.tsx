import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/web/components/App.tsx';
import { PlanReview } from '../../src/web/components/Palette.tsx';
import { Unlock } from '../../src/web/components/Unlock.tsx';
import { StoreProvider } from '../../src/web/lib/store.tsx';
import { baseState, mockFetch } from './fetchMock.ts';

const withStore = (ui: React.ReactNode) => render(<StoreProvider>{ui}</StoreProvider>);

describe('App shell', () => {
  it('asks for the login link when there is no session', async () => {
    mockFetch({
      'GET /api/state': { status: 401, body: { error: 'unauthenticated', message: 'no' } },
      'GET /api/jobs': { status: 401, body: {} },
    });
    withStore(<App />);
    expect(await screen.findByRole('heading', { name: 'Sign in to Farshelf' })).toBeInTheDocument();
    expect(screen.getByText('farshelf url')).toBeInTheDocument();
  });

  it('shows onboarding with a sensible default when there is no storage', async () => {
    mockFetch({ 'GET /api/state': () => baseState({ remotes: [] }), 'GET /api/jobs': () => ({ jobs: [] }) });
    withStore(<App />);
    expect(await screen.findByRole('heading', { name: 'Welcome to Farshelf' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Folder on this computer/ })).toBeChecked();
    expect(screen.getByLabelText('Folder path')).toHaveValue('~/Farshelf Storage');
  });

  it('keeps the recovery key on screen until the user confirms saving it', async () => {
    const user = userEvent.setup();
    let remotes: unknown[] = [];
    mockFetch({
      'GET /api/state': () => baseState({ remotes: remotes as never }),
      'GET /api/jobs': () => ({ jobs: [] }),
      'GET /api/remotes/r1/list': () => ({ entries: [] }),
      'POST /api/remotes': () => {
        remotes = baseState().remotes;
        return { remote: baseState().remotes[0], recoveryKey: 'ABCD-EFGH-JKMN' };
      },
    });
    withStore(<App />);
    await screen.findByRole('heading', { name: 'Welcome to Farshelf' });
    await user.click(screen.getByLabelText(/Encrypt file contents and names/));
    await user.type(screen.getByLabelText('Passphrase'), 'longenough');
    await user.type(screen.getByLabelText('Confirm passphrase'), 'longenough');
    await user.click(screen.getByRole('button', { name: 'Add storage' }));
    expect(await screen.findByTestId('recovery-key')).toHaveTextContent('ABCD-EFGH-JKMN');
    const cont = screen.getByRole('button', { name: 'Continue' });
    expect(cont).toBeDisabled();
    await user.click(screen.getByLabelText(/I have saved my recovery key/));
    await user.click(cont);
    expect(await screen.findByRole('region', { name: 'Files in Studio' })).toBeInTheDocument();
  });

  it('validates mismatched passphrases before calling the server', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      'GET /api/state': () => baseState({ remotes: [] }),
      'GET /api/jobs': () => ({ jobs: [] }),
    });
    withStore(<App />);
    await screen.findByRole('heading', { name: 'Welcome to Farshelf' });
    await user.click(screen.getByLabelText(/Encrypt file contents and names/));
    await user.type(screen.getByLabelText('Passphrase'), 'longenough');
    await user.type(screen.getByLabelText('Confirm passphrase'), 'different1');
    await user.click(screen.getByRole('button', { name: 'Add storage' }));
    expect(screen.getAllByText('Passphrases do not match').length).toBeGreaterThan(0);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('lists files and supports keyboard navigation', async () => {
    const user = userEvent.setup();
    mockFetch({
      'GET /api/state': () => baseState(),
      'GET /api/jobs': () => ({ jobs: [] }),
      'GET /api/remotes/r1/list': (_b, url) =>
        url.searchParams.get('path') === '/'
          ? {
              entries: [
                { name: 'b.mov', path: '/b.mov', kind: 'file', size: 5e9, mtime: 0 },
                { name: 'Footage', path: '/Footage', kind: 'dir', size: 0, mtime: 0 },
              ],
            }
          : { entries: [] },
    });
    withStore(<App />);
    const rows = await screen.findAllByRole('row');
    expect(rows[1]).toHaveTextContent('Footage'); // folders first
    expect(rows[2]).toHaveTextContent('5 GB');
    act(() => rows[1]!.focus());
    await user.keyboard('{ArrowDown}');
    expect(rows[2]).toHaveFocus();
    await user.keyboard('{ArrowUp}{Enter}');
    expect(await screen.findByText('This folder is empty')).toBeInTheDocument();
  });
});

describe('Unlock', () => {
  it('shows the server error and switches to recovery key', async () => {
    const user = userEvent.setup();
    mockFetch({
      'GET /api/state': () => baseState(),
      'GET /api/jobs': () => ({ jobs: [] }),
      'POST /api/remotes/r1/unlock': {
        status: 422,
        body: { error: 'decrypt_failed', message: 'wrong passphrase' },
      },
    });
    withStore(<Unlock remote={{ ...baseState().remotes[0]!, encrypted: true, locked: true }} />);
    await user.type(screen.getByLabelText('Passphrase'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('wrong passphrase')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use recovery key instead' }));
    expect(screen.getByLabelText('Recovery key')).toBeInTheDocument();
  });
});

describe('AI plan review', () => {
  it('runs only the steps the user approved, marking them as AI-sourced', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      'GET /api/state': () => baseState(),
      'GET /api/jobs': () => ({ jobs: [] }),
      'POST /api/remotes/r1/mkdir': () => ({ ok: true }),
      'POST /api/remotes/r1/move': () => ({ ok: true }),
      'POST /api/remotes/r1/trash': () => ({ ok: true }),
    });
    withStore(
      <PlanReview
        remoteId="r1"
        note={null}
        onDone={() => undefined}
        plan={{
          summary: 'Tidy',
          steps: [
            { tool: 'mkdir', path: '/stems' },
            { tool: 'move', from: '/a.wav', to: '/stems/a.wav' },
            { tool: 'trash', path: '/old.wav' },
          ],
        }}
      />,
    );
    expect(screen.getByText(/Suggested by AI/)).toBeInTheDocument();
    await user.click(screen.getByLabelText('Approve: Move /old.wav to trash'));
    await user.click(screen.getByRole('button', { name: 'Run 2 approved steps' }));
    await waitFor(() => expect(screen.getAllByLabelText('done')).toHaveLength(2));
    const writes = calls.filter((c) => c.method === 'POST');
    expect(writes.map((c) => c.path)).toEqual(['/api/remotes/r1/mkdir', '/api/remotes/r1/move']);
    expect(writes.every((c) => (c.body as { source: string }).source === 'ai')).toBe(true);
  });

  it('reports a failing step without hiding the others', async () => {
    const user = userEvent.setup();
    mockFetch({
      'GET /api/state': () => baseState(),
      'GET /api/jobs': () => ({ jobs: [] }),
      'POST /api/remotes/r1/mkdir': {
        status: 409,
        body: { error: 'conflict', message: 'stems already exists' },
      },
      'POST /api/remotes/r1/move': () => ({ ok: true }),
    });
    withStore(
      <PlanReview
        remoteId="r1"
        note={null}
        onDone={() => undefined}
        plan={{
          summary: 'x',
          steps: [
            { tool: 'mkdir', path: '/stems' },
            { tool: 'move', from: '/a', to: '/stems/a' },
          ],
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Run 2 approved steps' }));
    expect(await screen.findByText('stems already exists')).toBeInTheDocument();
    expect(await screen.findByLabelText('done')).toBeInTheDocument();
  });
});
