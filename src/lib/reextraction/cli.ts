/**
 * Everything the operator types or exports, read and refused before anything
 * is loaded, connected to or written.
 *
 * It lives here rather than in `scripts/reextract/run.ts` for two reasons.
 * The first is that `tsconfig.json` compiles `src/**` and nothing else, so a
 * parser in the script is a parser nothing typechecks. The second is that
 * these are the decisions with the shortest path to a wrong campaign: a run
 * that resolved `--campaign-name` to whichever of two campaigns Prisma
 * happened to return first, or that took `--batch` as `NaN`, would go on to
 * re-arm a thousand contacts perfectly correctly against the wrong target.
 *
 * Pure, and takes its environment as an argument rather than reading
 * `process.env`, so every refusal below is a case in `reextraction-cli.test.ts`
 * rather than something an operator discovers at half past ten at night.
 */

/** Batches of twenty and four at a time, as `runReextraction` itself defaults;
 *  restated because a CLI that passes `undefined` cannot report what it will
 *  do in the header before batch 1. */
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_BATCH_SIZE = 20;

/** The platform this tool was built against. Overridable for a local backend;
 *  the token is not, because there is no sensible default for a credential. */
const DEFAULT_API_URL = 'https://api.vocobase.com';

/**
 * A run that will not start, said to the operator in one line.
 *
 * Distinct from `ReextractionRefused`, which is the run refusing a campaign it
 * has already looked at: this is the tool refusing to begin. The caller exits
 * 2 on it — the shell's "you asked for something impossible" — leaving 1 for a
 * run that started and could not finish.
 */
export class CliRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliRefusal';
  }
}

export interface CliArgs {
  help: boolean;
  campaignId: string | null;
  campaignName: string | null;
  /** False writes nothing at all: the same judgements, the same report. */
  apply: boolean;
  force: boolean;
  concurrency: number;
  batchSize: number;
  /** Do not pause between batches. */
  yes: boolean;
  /** Stop before applying a batch that would take the run's reopened `stop`
   *  count past this. Null is no ceiling. */
  maxReopenedStops: number | null;
}

export const USAGE = `
Re-extract a paused campaign's finished conversations under the current
call-note contract, and re-arm each contact from the new note.

  npm run reextract -- --campaign <id> [options]
  npm run reextract -- --campaign-name "<exact name>" [options]

Options
  --campaign <id>          The campaign to re-judge.
  --campaign-name <name>   The same campaign by its exact name; refuses unless
                           exactly one campaign carries it.
  --apply                  Write. Without it the run is a dry run: every
                           conversation is judged and reported, nothing is
                           written.
  --force                  Re-judge conversations an earlier run already
                           stamped. Without it they are skipped, which is what
                           makes a stopped run resumable.
  --batch <n>              Conversations judged before the run pauses (default
                           ${DEFAULT_BATCH_SIZE}). A batch is applied only once all of it has
                           been judged.
  --concurrency <n>        Model calls in flight within a batch (default ${DEFAULT_CONCURRENCY}).
  --max-reopened-stops <n> Stop before applying a batch that would take the
                           run's count of reopened stops past n. Off by
                           default.
  --yes                    Do not pause between batches.
  --help                   This.

Environment (exported, never read from a file)
  DATABASE_URL                  The database this run reads and writes.
  VOCOBASE_ADMIN_DEBUG_TOKEN    Reads the session dumps.
  VOCOBASE_API_URL              Platform base (default ${DEFAULT_API_URL}).
  SIM_BASE_URL, SIM_API_KEY, SIM_MODEL
                                The OpenAI-compatible endpoint that judges.

The rest of the backend's own configuration (CLERK_SECRET_KEY, REDIS_URL and
the others) is read by src/lib/env.ts the usual way, so run this from the repo
root with the backend .env in place.
`.trim();

/**
 * As much of an unrecognised argument as is safe to print back.
 *
 * A bare `--flag` carries no value and cannot be a paste of one, so it is named
 * in full: it is a typo, and hiding it helps nobody. Anything else — a stray
 * positional, or a flag with a value attached — is shown four characters deep,
 * because `--token=sk_live_…` is one paste away and this refusal goes to a
 * terminal buffer, a screenshot and a chat thread in that order.
 */
function clip(token: string): string {
  if (token.startsWith('--') && !token.includes('=')) return token;

  return token.length <= 4 ? token : `${token.slice(0, 4)}…`;
}

/** The value of a flag that takes one, refusing the two ways it goes missing:
 *  omitted at the end of the line, and swallowed by the next flag. */
function valueOf(flag: string, raw: string | undefined): string {
  if (raw === undefined || raw === '' || raw.startsWith('--')) {
    throw new CliRefusal(`reextract: ${flag} needs a value.`);
  }

  return raw;
}

/**
 * A count, which must be whole and at least one.
 *
 * `Number('four')` is `NaN`, and `Math.max(1, NaN)` is `NaN` — a batch size of
 * `NaN` slices nothing and the run reports a campaign as having no
 * conversations at all. It is a typo, and it must read as one.
 */
function countOf(flag: string, raw: string | undefined): number {
  const text = valueOf(flag, raw);
  const value = Number(text);

  if (!Number.isInteger(value) || value < 1) {
    throw new CliRefusal(
      `reextract: ${flag} must be a whole number of at least 1; got ${JSON.stringify(text)}`,
    );
  }

  return value;
}

/**
 * Read the command line.
 *
 * `--flag value` and `--flag=value` both, because an operator who has just
 * copied a campaign name out of the dashboard will type whichever their shell
 * history last showed them.
 */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    help: false,
    campaignId: null,
    campaignName: null,
    apply: false,
    force: false,
    concurrency: DEFAULT_CONCURRENCY,
    batchSize: DEFAULT_BATCH_SIZE,
    yes: false,
    maxReopenedStops: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const eq = token.indexOf('=');
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const flag = eq === -1 ? token : token.slice(0, eq);
    // A flag written `--batch=5` has its value in hand; one written `--batch 5`
    // takes the next token, which is then consumed.
    const take = (): string | undefined => {
      if (inline !== undefined) return inline;

      index += 1;

      return argv[index];
    };

    switch (flag) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--apply':
        args.apply = true;
        break;
      case '--force':
        args.force = true;
        break;
      case '--yes':
      case '-y':
        args.yes = true;
        break;
      case '--campaign':
        args.campaignId = valueOf('--campaign', take());
        break;
      case '--campaign-name':
        args.campaignName = valueOf('--campaign-name', take());
        break;
      case '--concurrency':
        args.concurrency = countOf('--concurrency', take());
        break;
      case '--batch':
        args.batchSize = countOf('--batch', take());
        break;
      case '--max-reopened-stops':
        args.maxReopenedStops = countOf('--max-reopened-stops', take());
        break;
      default:
        // Judged on the whole token rather than the flag half, so
        // `--token=sk_live_…` is clipped and a bare `--dry-run` is not.
        throw new CliRefusal(`reextract: unknown argument ${clip(token)}. Run with --help.`);
    }
  }

  if (args.help) return args;

  if (args.campaignId !== null && args.campaignName !== null) {
    throw new CliRefusal('reextract: pass either --campaign or --campaign-name, not both.');
  }

  if (args.campaignId === null && args.campaignName === null) {
    throw new CliRefusal('reextract: pass --campaign <id> or --campaign-name "<exact name>".');
  }

  return args;
}

export interface RunConfig {
  /** Checked here, used by Prisma. */
  databaseUrl: string;
  apiUrl: string;
  token: string;
  sim: { baseUrl: string; apiKey: string; model: string };
}

/**
 * The variable, or a refusal naming it and nothing else.
 *
 * Naming only the variable is the whole point: two of the five are
 * credentials, and a message that quoted the environment back would put a live
 * API key in a terminal buffer, a screenshot and a chat thread in that order.
 */
function requireVar(env: Record<string, string | undefined>, name: string, why: string): string {
  const value = env[name];

  if (value === undefined || value.trim() === '') {
    throw new CliRefusal(`reextract: ${name} is not set in the environment (${why}).`);
  }

  return value.trim();
}

/** `https://host/v1//` and `https://host/v1` are the same endpoint, and only
 *  one of them appends `/chat/completions` correctly. */
function base(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Read the environment the run needs, from an environment passed in.
 *
 * `process.env` only at the call site, never a file — not even the `.env` the
 * rest of the backend reads. Two reasons, and the second is the load-bearing
 * one. The token and the model key are credentials that must not be sitting in
 * a repo file. And `DATABASE_URL` decides which database a thousand contacts
 * get re-armed in: exporting it makes the operator state the target for this
 * one command, rather than inheriting whatever a checked-out `.env` last
 * pointed at.
 */
export function readConfig(env: Record<string, string | undefined>): RunConfig {
  const apiUrl = env.VOCOBASE_API_URL?.trim();

  return {
    databaseUrl: requireVar(env, 'DATABASE_URL', 'export the database this run must write to'),
    apiUrl: base(apiUrl === undefined || apiUrl === '' ? DEFAULT_API_URL : apiUrl),
    token: requireVar(env, 'VOCOBASE_ADMIN_DEBUG_TOKEN', 'reads the session dumps'),
    sim: {
      baseUrl: base(requireVar(env, 'SIM_BASE_URL', 'the endpoint that judges the calls')),
      apiKey: requireVar(env, 'SIM_API_KEY', 'authenticates against that endpoint'),
      model: requireVar(env, 'SIM_MODEL', 'the model that judges the calls'),
    },
  };
}

export interface CampaignCandidate {
  id: string;
  name: string;
}

function candidateLines(candidates: CampaignCandidate[]): string[] {
  return candidates.map((candidate) => `  ${candidate.id}  ${candidate.name}`);
}

/**
 * What to say when `--campaign-name` did not name exactly one campaign.
 *
 * Both halves end in the same instruction — pass `--campaign <id>` — because
 * both are the same situation from the tool's side: it will not guess which
 * campaign a person meant when the answer decides which thousand telephone
 * numbers get dialled again. What differs is what is worth printing: the
 * ambiguous matches when there were several, and the near misses when there
 * were none, since a name typed one space out is the likelier mistake by far.
 */
export function campaignNameError(input: {
  name: string;
  /** Exact matches; zero or two-and-up, since exactly one resolves. */
  matches: CampaignCandidate[];
  /** Names containing the string, offered only when nothing matched exactly. */
  similar: CampaignCandidate[];
}): string {
  if (input.matches.length > 1) {
    return [
      `reextract: ${input.matches.length} campaigns are named "${input.name}"; pass --campaign <id> with one of:`,
      ...candidateLines(input.matches),
    ].join('\n');
  }

  if (input.similar.length > 0) {
    return [
      `reextract: no campaign is named "${input.name}" exactly. Did you mean one of these? Pass --campaign <id>:`,
      ...candidateLines(input.similar),
    ].join('\n');
  }

  return `reextract: no campaign is named "${input.name}", and none has a name containing it.`;
}

/**
 * The question asked once, before the first conversation is judged.
 *
 * Every other confirmation in this tool comes after a batch has been judged and
 * an operator has read a table of what it would do. This one comes before
 * anything at all, because the mistake it guards against is the one no batch
 * table can catch: a real, paused, perfectly valid campaign that is not the
 * campaign the operator meant. Without it the first twenty contacts of the
 * wrong campaign are re-armed before there is anything to read.
 */
export function applyPrompt(input: { campaignId: string; campaignName: string }): string {
  return `Re-arm contacts of "${input.campaignName}" (${input.campaignId})? [y/N] `;
}

/**
 * The four lines printed before the first conversation is fetched.
 *
 * The campaign's NAME beside its id, because an id is twenty-six characters an
 * operator cannot check by eye, and the target is the one thing that must be
 * right before anything else about the run matters. The mode is spelled out in
 * words rather than as a flag echo, so `--apply` typed by habit is visible as
 * "contacts will be re-armed" while there is still a prompt to answer.
 *
 * No environment value appears here — not the endpoint, not the model. This
 * header is the first thing copied into a chat when a run goes sideways.
 */
export function renderHeader(input: {
  campaignId: string;
  campaignName: string;
  apply: boolean;
  batchSize: number;
  concurrency: number;
  yes: boolean;
}): string {
  const mode = input.apply
    ? 'APPLY — contacts will be re-armed and attempts rewritten'
    : 'DRY RUN — every conversation is judged, nothing is written';
  const pausing = input.yes
    ? `${input.batchSize} conversations (no pause between batches)`
    : `${input.batchSize} conversations (pause after each batch)`;

  return [
    `Re-extraction of "${input.campaignName}" (${input.campaignId})`,
    `  Mode:        ${mode}`,
    `  Batch:       ${pausing}`,
    `  Concurrency: ${input.concurrency}`,
    '',
  ].join('\n');
}
