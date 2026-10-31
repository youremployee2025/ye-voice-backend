import { ApiError } from './errors.js';

/**
 * Offset pagination for the staff listings.
 *
 * Offsets rather than cursors, deliberately: these lists are staff-facing,
 * ordered newest-first, and small enough that a `COUNT(*)` is worth being able
 * to say "1,284 accounts". A cursor would buy stability under concurrent
 * inserts that nobody reading an operations console is troubled by.
 */

const DEFAULT_LIMIT = 25;

/** One page must not be able to ask for the whole platform. */
const MAX_LIMIT = 100;

export interface Pagination {
  page: number;
  limit: number;
  skip: number;
  take: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

/**
 * The largest page this will accept.
 *
 * Not a cap on the data — a page past the end is an empty `items` — but a cap
 * on the arithmetic. `page * limit` becomes the offset, and an offset has to
 * survive being a JavaScript number and then a database integer. A million
 * pages is already far past anything an operations console will scroll to.
 */
const MAX_PAGE = 1_000_000;

/**
 * A whole number ≥ 1, or the fallback when the parameter is absent.
 *
 * Bad input throws rather than falling back. Ignoring `?page=x` would answer
 * page 1's rows under page x's heading, and a listing that quietly shows the
 * wrong rows is worse than one that refuses.
 *
 * "Bad" includes numbers too large to be a number. The regex below accepts any
 * run of digits, and `Number` turns a long enough one into a float: 1e20 is
 * not an integer, so the `skip` derived from it reached Prisma as a value it
 * refuses and came back a 500 — from the module whose whole purpose is to make
 * that a 400. Just short of that, precision goes first and quietly:
 * `Number('9007199254740993')` is 9007199254740992, so the response would echo
 * back a different page than the one asked for. Both are rejected here.
 */
function positive(name: string, raw: unknown, fallback: number, max: number): number {
  if (raw === undefined) return fallback;

  if (typeof raw !== 'string' || raw.trim() === '' || !/^\d+$/.test(raw.trim())) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${name} must be a whole number of at least 1.`);
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `${name} must be a whole number between 1 and ${max}.`,
    );
  }

  return value;
}

export function parsePagination(query: Record<string, unknown>): Pagination {
  const page = positive('page', query.page, 1, MAX_PAGE);
  // Clamped rather than rejected: asking for more than the cap is a reasonable
  // thing to want, and the cap is ours to enforce, not theirs to get right.
  // Still bounded above first, so the clamp is applied to a real number.
  const limit = Math.min(
    positive('limit', query.limit, DEFAULT_LIMIT, Number.MAX_SAFE_INTEGER),
    MAX_LIMIT,
  );

  return { page, limit, skip: (page - 1) * limit, take: limit };
}

export function paginated<T>(items: T[], total: number, { page, limit }: Pagination): Page<T> {
  return { items, page, limit, total };
}
