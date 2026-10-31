import { describe, expect, it, vi, afterEach } from 'vitest';
import { DEFAULT_RANGE_DAYS, parseAnalyticsRange } from '../src/lib/analyticsQuery.js';
import { ApiError } from '../src/lib/errors.js';

const iso = (at: Date) => at.toISOString();

afterEach(() => {
  vi.useRealTimers();
});

describe('parseAnalyticsRange', () => {
  it('reads a bare date as a whole UTC day at each end', () => {
    const range = parseAnalyticsRange({ from: '2026-08-01', to: '2026-08-01' });

    expect(iso(range.from)).toBe('2026-08-01T00:00:00.000Z');
    expect(iso(range.to)).toBe('2026-08-01T23:59:59.999Z');
  });

  it('reads a timestamp with an explicit zone verbatim', () => {
    const range = parseAnalyticsRange({
      from: '2026-08-01T00:00:00.000+05:30',
      to: '2026-08-02T00:00:00.000Z',
    });

    expect(iso(range.from)).toBe('2026-07-31T18:30:00.000Z');
    expect(iso(range.to)).toBe('2026-08-02T00:00:00.000Z');
  });

  it('refuses a timestamp with no zone', () => {
    // Exactly what <input type="datetime-local"> emits. Resolved against the
    // server's clock it means a different instant per deployment, and nothing
    // about the answer would say so.
    expect(() => parseAnalyticsRange({ from: '2026-08-01T00:00' })).toThrow(ApiError);
  });

  it('refuses a shape that parses but is not a day', () => {
    expect(() => parseAnalyticsRange({ from: '2026-13-45' })).toThrow(ApiError);
  });

  it('refuses from later than to', () => {
    expect(() => parseAnalyticsRange({ from: '2026-08-02', to: '2026-08-01' })).toThrow(ApiError);
  });

  it('accepts from equal to to — one day is a range', () => {
    expect(() => parseAnalyticsRange({ from: '2026-08-01', to: '2026-08-01' })).not.toThrow();
  });

  it('refuses a parameter given twice rather than picking one', () => {
    expect(() => parseAnalyticsRange({ from: ['2026-08-01', '2026-08-02'] })).toThrow(ApiError);
  });

  it('defaults to the last 30 days, ending now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T09:15:00.000Z'));

    const range = parseAnalyticsRange({});

    expect(iso(range.to)).toBe('2026-08-31T09:15:00.000Z');
    expect(iso(range.from)).toBe('2026-08-01T09:15:00.000Z');
    expect(DEFAULT_RANGE_DAYS).toBe(30);
  });

  it('defaults only the end that is missing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T09:15:00.000Z'));

    // A `from` with no `to` means "since then", not "the 30 days after then".
    expect(iso(parseAnalyticsRange({ from: '2026-08-20' }).to)).toBe('2026-08-31T09:15:00.000Z');
    // A `to` with no `from` means the 30 days before it, not the 30 before now.
    expect(iso(parseAnalyticsRange({ to: '2026-08-20' }).from)).toBe('2026-07-21T23:59:59.999Z');
  });

  it('always returns both bounds, so no aggregate branches on an open range', () => {
    const range = parseAnalyticsRange({});

    expect(range.from).toBeInstanceOf(Date);
    expect(range.to).toBeInstanceOf(Date);
  });

  it('refuses a range wider than the cap', () => {
    // The series is dense — a day with no calls is a zero emitted from the
    // range rather than from the rows — so the response grows with the span
    // asked for and not with the data behind it. `from` accepts any four-digit
    // year, which is ~3M day objects and several hundred megabytes resident, on
    // a route open to any member and carrying no rate limit.
    expect(() => parseAnalyticsRange({ from: '0001-01-01', to: '2026-08-31' })).toThrow(
      /must not be longer than 366 days/,
    );
  });

  it('applies the cap to the resolved pair, not to what was sent', () => {
    // Otherwise naming one end and letting the other default walks straight
    // past it.
    expect(() => parseAnalyticsRange({ from: '2000-01-01' })).toThrow(/366 days/);
  });

  it('accepts a range exactly at the cap', () => {
    const range = parseAnalyticsRange({ from: '2026-01-01', to: '2026-12-31' });
    expect(range.from).toEqual(new Date('2026-01-01T00:00:00.000Z'));
  });

  it('treats an empty string as absent rather than as a bad date', () => {
    expect(() => parseAnalyticsRange({ from: '', to: '' })).not.toThrow();
  });
});
