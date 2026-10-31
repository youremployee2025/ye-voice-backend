import { parse } from 'csv-parse/sync';
import { canonicalizeE164, type CountryCode } from './phone.js';

export interface ParsedContactRow {
  row: number;
  phone: string;
  name?: string;
  email?: string;
  /** Always present, possibly empty — an absent `tags` column is "no tags in
   *  this file", which reads the same as an empty cell. */
  tags: string[];
  metadata: Record<string, string>;
}

export interface InvalidContactRow {
  row: number;
  phone: string;
  reason: string;
}

export interface ParsedContactsCsv {
  rows: ParsedContactRow[];
  invalid: InvalidContactRow[];
}

/** A problem with the file as a whole — no row in it could have succeeded. */
export class CsvError extends Error {
  constructor(
    readonly code: 'CSV_PARSE_ERROR' | 'CSV_PHONE_COLUMN_MISSING',
    message: string,
  ) {
    super(message);
    this.name = 'CsvError';
  }
}

const PHONE_HEADER = 'phone';
const NAME_HEADER = 'name';
const EMAIL_HEADER = 'email';
const TAGS_HEADER = 'tags';

/** The columns that land on a `Contact` column of their own. Everything else
 *  is metadata, verbatim. */
const KNOWN_HEADERS: readonly string[] = [PHONE_HEADER, NAME_HEADER, EMAIL_HEADER, TAGS_HEADER];

/**
 * The separators a spreadsheet's "tags" cell might use.
 *
 * All three, because the operator did not choose one — their CRM's export did,
 * and a file exported with semicolons should not silently become one contact
 * carrying a single tag named `vip;lapsed;india`.
 */
const TAG_SEPARATORS = /[;,|]/;

function readTags(raw: string | undefined): string[] {
  if (!raw) return [];

  return raw
    .split(TAG_SEPARATORS)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/**
 * Parses an uploaded CSV into contact rows.
 *
 * A row-level problem never fails the file: an unusable phone number is
 * reported in `invalid` with the row number a spreadsheet shows — the header
 * is row 1 — and every other row still loads. A 900-row file with three bad
 * numbers is fixable; the same file rejected wholesale is not.
 *
 * Row numbers come from the parser's own line count, NOT from the index of the
 * record in the result. Blank lines are skipped and a quoted field may span
 * several lines, so the two diverge the moment a file contains either — and a
 * row number that points at the wrong line is worse than none at all, because
 * it sends the operator to a row that looks fine.
 *
 * Columns other than phone, name, email and tags are kept verbatim as
 * metadata, so the spreadsheet itself defines the per-contact variables without
 * a separate mapping step. Those four have columns of their own on `Contact`
 * because the product segments and searches on them; the rest is the
 * customer's own data and is treated as opaque.
 */
export function parseContactsCsv(
  buffer: Buffer,
  defaultCountry?: CountryCode,
): ParsedContactsCsv {
  interface Parsed {
    record: Record<string, string>;
    info: { lines: number };
  }

  // Captured from the header callback rather than read back off a parsed
  // record: relax_column_count lets a short row through, and such a record is
  // missing its trailing keys entirely. Inferring the header from one would
  // lose columns the file plainly has.
  let headers: string[] = [];
  let records: Parsed[];

  try {
    records = parse(buffer, {
      bom: true,
      columns: (header: string[]) => {
        headers = header.map((h) => h.trim().toLowerCase());
        return headers;
      },
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      info: true,
    }) as Parsed[];
  } catch (error) {
    throw new CsvError(
      'CSV_PARSE_ERROR',
      error instanceof Error ? error.message : 'That file could not be read as CSV.',
    );
  }

  // `columns` consumed the first line as headers, so a file with no data rows
  // yields none here — indistinguishable from an empty file, and equally
  // unusable either way.
  if (records.length === 0 || !headers.includes(PHONE_HEADER)) {
    throw new CsvError(
      'CSV_PHONE_COLUMN_MISSING',
      'The CSV needs a header row with a "phone" column, and at least one row under it.',
    );
  }

  const rows: ParsedContactRow[] = [];
  const invalid: InvalidContactRow[] = [];

  records.forEach(({ record, info }) => {
    // The line this record ended on, which for an ordinary one-line row is the
    // line it occupies. The header is line 1, so these already match the file.
    const row = info.lines;
    const raw = (record[PHONE_HEADER] ?? '').trim();

    if (!raw) {
      invalid.push({ row, phone: '', reason: 'Phone number is required.' });
      return;
    }

    const phone = canonicalizeE164(raw, defaultCountry);
    if (!phone) {
      invalid.push({
        row,
        phone: raw,
        reason: 'Not a valid phone number. Include the country code, e.g. +919876543210.',
      });
      return;
    }

    const metadata: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!key || KNOWN_HEADERS.includes(key)) continue;
      if (value) metadata[key] = value;
    }

    const name = (record[NAME_HEADER] ?? '').trim();
    const email = (record[EMAIL_HEADER] ?? '').trim();

    rows.push({
      row,
      phone,
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
      tags: readTags(record[TAGS_HEADER]),
      metadata,
    });
  });

  return { rows, invalid };
}
