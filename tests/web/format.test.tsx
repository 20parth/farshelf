import { describe, expect, it } from 'vitest';
import {
  baseName,
  fileKind,
  formatBytes,
  formatDate,
  formatEta,
  joinPath,
  parentOf,
} from '../../src/web/lib/format.ts';

describe('format helpers', () => {
  it('formats sizes, ETAs and dates', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(48_200_000_000)).toBe('48 GB');
    expect(formatBytes(4_200_000)).toBe('4.2 MB');
    expect(formatEta(600, 10)).toBe('about 1 min left');
    expect(formatEta(0, 10)).toBe('');
    const now = Date.UTC(2026, 9, 29, 12);
    expect(formatDate(now - 30_000, now)).toBe('just now');
    expect(formatDate(now - 5 * 60_000, now)).toBe('5 min ago');
  });
  it('handles paths and kinds', () => {
    expect(joinPath('/', 'a')).toBe('/a');
    expect(joinPath('/a', 'b')).toBe('/a/b');
    expect(parentOf('/a/b')).toBe('/a');
    expect(parentOf('/a')).toBe('/');
    expect(baseName('/a/b.mov')).toBe('b.mov');
    expect(fileKind('x.MOV')).toBe('video');
    expect(fileKind('x.flac')).toBe('audio');
    expect(fileKind('x.unknown')).toBe('other');
  });
});
