import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/errors.js';
import { paginated, parsePagination } from '../src/lib/pagination.js';

describe('parsePagination', () => {
  it('defaults to the first page of 25', () => {
    expect(parsePagination({})).toEqual({ page: 1, limit: 25, skip: 0, take: 25 });
  });

  it('turns a page into an offset', () => {
    expect(parsePagination({ page: '3', limit: '10' })).toEqual({
      page: 3,
      limit: 10,
      skip: 20,
      take: 10,
    });
  });

  it('caps the limit so one request cannot ask for the whole platform', () => {
    expect(parsePagination({ limit: '5000' }).limit).toBe(100);
  });

  // A silently ignored page number returns page 1's rows under page 4's
  // heading, which reads as "these are the rows" rather than as a mistake.
  it.each(['0', '-1', '1.5', 'two', ''])('rejects page=%j', (page) => {
    expect(() => parsePagination({ page })).toThrow(ApiError);
  });

  it.each(['0', '-5', 'ten'])('rejects limit=%j', (limit) => {
    expect(() => parsePagination({ limit })).toThrow(ApiError);
  });

  it('reports a bad page as a validation error', () => {
    try {
      parsePagination({ page: 'x' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('paginated', () => {
  it('carries the total alongside the page', () => {
    expect(paginated(['a'], 41, { page: 2, limit: 20, skip: 20, take: 20 })).toEqual({
      items: ['a'],
      page: 2,
      limit: 20,
      total: 41,
    });
  });

  // A page past the end is a stale link, not an error: the list shrank.
  it('answers an empty page rather than failing', () => {
    expect(paginated([], 3, { page: 9, limit: 25, skip: 200, take: 25 })).toEqual({
      items: [],
      page: 9,
      limit: 25,
      total: 3,
    });
  });
});

describe('page numbers a database could not honour', () => {
  it('rejects a page past what an offset can express, rather than failing at the query', () => {
    // `Number('99999999999999999999')` is 1e20: a float, not an integer, and
    // `skip` derived from it reaches Prisma as a non-integer and comes back a
    // 500 — on input this module had already promised to validate.
    expect(() => parsePagination({ page: '99999999999999999999' })).toThrow(ApiError);
  });

  it('rejects a page past the safe integer range rather than silently renaming it', () => {
    // 9007199254740993 is not representable as a double; it round-trips as
    // ...992, so the response would echo a different page than was asked for.
    expect(() => parsePagination({ page: '9007199254740993' })).toThrow(ApiError);
  });

  it('rejects an oversized limit the same way', () => {
    expect(() => parsePagination({ limit: '99999999999999999999' })).toThrow(ApiError);
  });

  it('still accepts a large but honourable page', () => {
    expect(parsePagination({ page: '1000' })).toMatchObject({ page: 1000, skip: 24_975 });
  });
});
