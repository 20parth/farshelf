import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom does not implement EventSource; the store opens one for live updates.
class FakeEventSource {
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  addEventListener() {}
  close() {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
