import { describe, expect, it } from 'vitest';
import { describeDatabaseTarget } from '../src/lib/scriptTarget.js';

/**
 * Where an operator script is about to write, said out loud before it does.
 *
 * Three backfill runs in one day went to the wrong database, and each was
 * caught only by luck: the local database lacked a column, or lacked the
 * campaign. `dotenv` loads `.env` from the working directory and does not
 * override a shell variable, so the same command reaches production from one
 * shell and localhost from another with nothing on screen saying which — until
 * something fails, or worse, succeeds quietly against the wrong data.
 */
describe('describeDatabaseTarget', () => {
  it('names the host and database', () => {
    expect(describeDatabaseTarget('postgresql://u:p@dpg-abc.oregon-postgres.render.com/ye_voice')).toEqual({
      host: 'dpg-abc.oregon-postgres.render.com',
      database: 'ye_voice',
      isLocal: false,
    });
  });

  it('recognises a local database', () => {
    expect(describeDatabaseTarget('postgresql://postgres:x@localhost:5454/ye_voice').isLocal).toBe(true);
    expect(describeDatabaseTarget('postgresql://postgres:x@127.0.0.1/ezo').isLocal).toBe(true);
  });

  /** The password is in the url. It must never reach a log line. */
  it('never returns the credential', () => {
    const target = describeDatabaseTarget('postgresql://user:s3cret@host.example/db');

    expect(JSON.stringify(target)).not.toContain('s3cret');
    expect(JSON.stringify(target)).not.toContain('user');
  });

  it('reports an unreadable url rather than throwing', () => {
    expect(describeDatabaseTarget('not a url')).toEqual({ host: null, database: null, isLocal: false });
    expect(describeDatabaseTarget(undefined)).toEqual({ host: null, database: null, isLocal: false });
  });
});

import { guardDatabaseTarget } from '../src/lib/scriptTarget.js';

describe('guardDatabaseTarget', () => {
  const remote = 'postgresql://u:p@dpg-abc.oregon-postgres.render.com/ye_voice';
  const local = 'postgresql://postgres:x@localhost:5454/ye_voice';

  it('refuses a remote database without --production', () => {
    const reason = guardDatabaseTarget({ url: remote, production: false, dryRun: false, log: () => {} });

    expect(reason).toMatch(/--production/);
  });

  it('allows a remote database with --production', () => {
    expect(guardDatabaseTarget({ url: remote, production: true, dryRun: false, log: () => {} })).toBeNull();
  });

  /** A dry run reads nothing upstream and writes nothing, and its whole point
   *  is to show what a real run would touch — so it may see any database. */
  it('allows a dry run against a remote database, since it writes nothing', () => {
    expect(guardDatabaseTarget({ url: remote, production: false, dryRun: true, log: () => {} })).toBeNull();
  });

  /** The failure that actually happened. Allowed, because a local run is a
   *  legitimate thing to want — but said loudly, because the one nobody wants
   *  looks identical until something fails. */
  it('allows a local database and says so loudly', () => {
    const lines: string[] = [];

    expect(guardDatabaseTarget({ url: local, production: false, dryRun: false, log: (l) => lines.push(l) })).toBeNull();
    expect(lines.join('\n')).toMatch(/LOCAL/);
    expect(lines.join('\n')).toMatch(/export DATABASE_URL/);
  });

  it('always prints the host before anything else, and never the password', () => {
    const lines: string[] = [];
    guardDatabaseTarget({ url: remote, production: true, dryRun: false, log: (l) => lines.push(l) });

    expect(lines[0]).toContain('dpg-abc.oregon-postgres.render.com/ye_voice');
    expect(lines.join('\n')).not.toContain(':p@');
  });

  it('stops on a missing url', () => {
    expect(guardDatabaseTarget({ url: undefined, production: true, dryRun: false, log: () => {} })).toMatch(/DATABASE_URL/);
  });
});
