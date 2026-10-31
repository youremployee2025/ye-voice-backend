/**
 * Where an operator script is about to write, so it can say so before it does.
 *
 * Three backfill runs in one day went to the wrong database, and each was
 * caught only by luck: the local database lacked a column, or lacked the
 * campaign. The mechanism is `dotenv` — it loads `.env` from the working
 * directory and does not override a variable already in the shell — so the
 * same command reaches production from one shell and localhost from another
 * with nothing on screen saying which. The tell was `injected env (14)`
 * against `injected env (0)`, which nobody reads.
 *
 * So every script that writes prints its target first, warns when that is a
 * local database (the failure that actually happened), and refuses a remote
 * one without `--production` (the failure that would be worse).
 */
export interface DatabaseTarget {
  host: string | null;
  database: string | null;
  isLocal: boolean;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Never the credential: the url carries the password, and this goes to a
 *  log line. */
export function describeDatabaseTarget(url: string | undefined): DatabaseTarget {
  if (!url) return { host: null, database: null, isLocal: false };

  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const database = parsed.pathname.replace(/^\//, '') || null;

    return { host, database, isLocal: LOCAL_HOSTS.has(host) };
  } catch {
    return { host: null, database: null, isLocal: false };
  }
}

/**
 * Prints the target and decides whether the script may go on.
 *
 * Returns the reason to stop, or null. The caller exits on a reason; this
 * does not, so it stays testable and so a dry run can still show the target.
 */
export function guardDatabaseTarget(options: {
  url: string | undefined;
  /** `--production` was passed. */
  production: boolean;
  /** A dry run reads nothing upstream and writes nothing; it may see any
   *  database, because seeing is the point of it. */
  dryRun: boolean;
  log?: (line: string) => void;
}): string | null {
  const log = options.log ?? console.log;
  const target = describeDatabaseTarget(options.url);

  if (!target.host) return 'DATABASE_URL is not set or is not a url.';

  log(`Database: ${target.host}/${target.database ?? '?'}${target.isLocal ? '  (LOCAL)' : ''}`);

  if (target.isLocal) {
    // The failure that actually happened: a shell without the export, and a
    // `.env` pointing at a dev database that either lacks the column or has
    // nothing to fill. Said loudly rather than refused — a local run is a
    // legitimate thing to want, and the message is what stops the wrong one.
    log('  This is a LOCAL database. To run against production, export DATABASE_URL first.');

    return null;
  }

  if (!options.production && !options.dryRun) {
    return (
      `Refusing to write to ${target.host} without --production. ` +
      'Add the flag to confirm this is the database you mean.'
    );
  }

  return null;
}
