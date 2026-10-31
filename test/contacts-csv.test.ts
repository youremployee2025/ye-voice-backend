import { describe, expect, it } from 'vitest';
import { CsvError, parseContactsCsv } from '../src/lib/contacts-csv.js';

const csv = (s: string) => Buffer.from(s, 'utf8');

describe('parseContactsCsv', () => {
  it('reads phone, name, and every other column as metadata', () => {
    const result = parseContactsCsv(csv('phone,name,city,plan\n+919876543210,Asha,Pune,Gold\n'));

    expect(result.invalid).toEqual([]);
    expect(result.rows).toEqual([
      {
        row: 2,
        phone: '+919876543210',
        name: 'Asha',
        tags: [],
        metadata: { city: 'Pune', plan: 'Gold' },
      },
    ]);
  });

  /**
   * `email` and `tags` have columns of their own on `Contact`, because the
   * product searches and segments on them. They must therefore NOT also land
   * in metadata, or a variable mapping built from the spreadsheet's headers
   * would offer the operator a variable that duplicates a column.
   */
  it('reads email and tags into their own fields, not into metadata', () => {
    const result = parseContactsCsv(
      csv('phone,email,tags,city\n+919876543210,asha@example.com,vip;lapsed,Pune\n'),
    );

    expect(result.rows[0]).toEqual({
      row: 2,
      phone: '+919876543210',
      email: 'asha@example.com',
      tags: ['vip', 'lapsed'],
      metadata: { city: 'Pune' },
    });
  });

  /**
   * Three separators, because the operator did not choose one — their CRM's
   * export did, and a semicolon-separated file must not become one contact
   * carrying a single tag named `vip;lapsed;india`.
   */
  it('splits tags on semicolons, commas and pipes, dropping the blanks', () => {
    const result = parseContactsCsv(
      csv('phone,tags\n+919876543210,"vip; lapsed,, india|churn|"\n'),
    );

    expect(result.rows[0]!.tags).toEqual(['vip', 'lapsed', 'india', 'churn']);
  });

  it('reads an absent or empty tags cell as no tags', () => {
    expect(parseContactsCsv(csv('phone\n+919876543210\n')).rows[0]!.tags).toEqual([]);
    expect(parseContactsCsv(csv('phone,tags\n+919876543210,\n')).rows[0]!.tags).toEqual([]);
  });

  it('treats header names case-insensitively', () => {
    const result = parseContactsCsv(csv('Phone,NAME\n+919876543210,Asha\n'));
    expect(result.rows[0]!.name).toBe('Asha');
  });

  it('requires a phone column', () => {
    expect(() => parseContactsCsv(csv('name,city\nAsha,Pune\n'))).toThrow(CsvError);
  });

  it('requires a header row it can use', () => {
    expect(() => parseContactsCsv(csv(''))).toThrow(CsvError);
    expect(() => parseContactsCsv(csv('phone\n'))).toThrow(CsvError);
  });

  it('reports a bad row by its spreadsheet row number and keeps the good ones', () => {
    const result = parseContactsCsv(
      csv('phone,name\n+919876543210,Asha\nnot-a-number,Bad\n,Blank\n+14155550132,Ravi\n'),
    );

    expect(result.rows.map((r) => r.phone)).toEqual(['+919876543210', '+14155550132']);
    expect(result.invalid).toEqual([
      { row: 3, phone: 'not-a-number', reason: expect.stringContaining('country code') },
      { row: 4, phone: '', reason: 'Phone number is required.' },
    ]);
  });

  it('rejects a bare national number without a default country', () => {
    const result = parseContactsCsv(csv('phone\n9876543210\n'));
    expect(result.rows).toEqual([]);
    expect(result.invalid[0]!.reason).toContain('country code');
  });

  it('accepts a bare national number against the campaign default country', () => {
    const result = parseContactsCsv(csv('phone\n9876543210\n'), 'IN');
    expect(result.rows[0]!.phone).toBe('+919876543210');
  });

  it('leaves a name blank rather than storing an empty string', () => {
    const result = parseContactsCsv(csv('phone,name\n+919876543210,\n'));
    expect(result.rows[0]!.name).toBeUndefined();
  });

  it('omits empty metadata cells rather than storing blanks', () => {
    const result = parseContactsCsv(csv('phone,city,plan\n+919876543210,,Gold\n'));
    expect(result.rows[0]!.metadata).toEqual({ plan: 'Gold' });
  });

  it('numbers rows by their line in the file, not by parsed-record index', () => {
    // A blank line is skipped by the parser but still occupies a line in the
    // operator's spreadsheet. Counting records instead of lines sends them to
    // the wrong row, and the drift compounds with every skipped line.
    const result = parseContactsCsv(csv('phone,name\n+919876543210,Asha\n\nnot-a-number,Bad\n'));

    expect(result.invalid).toEqual([
      { row: 4, phone: 'not-a-number', reason: expect.stringContaining('country code') },
    ]);
  });

  it('numbers rows past a quoted field that spans several lines', () => {
    // A record carrying an embedded newline is reported at the line it ends
    // on, so a row after it still points into the right part of the file
    // rather than drifting by the number of lines that record swallowed.
    const result = parseContactsCsv(
      csv('phone,name\n+919876543210,"Asha\nRao"\nnot-a-number,Bad\n'),
    );

    expect(result.rows[0]!.row).toBe(3);
    expect(result.invalid[0]!.row).toBe(4);
  });

  it('finds the phone column even when the first data row is short', () => {
    // relax_column_count lets a ragged row through, but a record built from it
    // is missing the trailing keys. Reading the header off that record loses
    // columns the file plainly has.
    const result = parseContactsCsv(csv('name,phone\nAlice\nBob,+919876543210\n'));

    expect(result.rows.map((r) => r.phone)).toEqual(['+919876543210']);
    expect(result.invalid).toEqual([
      { row: 2, phone: '', reason: 'Phone number is required.' },
    ]);
  });
});
