import { describe, expect, it } from 'vitest';
import {
  CliRefusal,
  applyPrompt,
  campaignNameError,
  parseArgs,
  readConfig,
  renderHeader,
} from '../src/lib/reextraction/cli.js';

/** The environment a real run is given, as the operator exports it. */
const ENV = {
  DATABASE_URL: 'postgresql://user:hunter2@db.example.com:5432/ezo',
  VOCOBASE_ADMIN_DEBUG_TOKEN: 'tok_live_should_never_be_printed',
  SIM_BASE_URL: 'https://models.example.com/v1',
  SIM_API_KEY: 'sk_should_never_be_printed',
  SIM_MODEL: 'contender-h',
};

/** The refusal a call was expected to make, as its message. */
function refusalOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof CliRefusal) return error.message;

    throw error;
  }

  throw new Error('expected a CliRefusal, got a value');
}

describe('the arguments', () => {
  it('takes a campaign id and defaults everything else', () => {
    expect(parseArgs(['--campaign', 'cmp_1'])).toStrictEqual({
      help: false,
      campaignId: 'cmp_1',
      campaignName: null,
      apply: false,
      force: false,
      concurrency: 4,
      batchSize: 20,
      yes: false,
      maxReopenedStops: null,
    });
  });

  it('takes a campaign name with spaces in it', () => {
    expect(parseArgs(['--campaign-name', 'Diwali reactivation'])).toMatchObject({
      campaignId: null,
      campaignName: 'Diwali reactivation',
    });
  });

  it('takes every switch, in either spelling of a valued flag', () => {
    expect(parseArgs(['--campaign=cmp_1', '--apply', '--force', '--yes', '--batch=5', '--concurrency', '2'])).toStrictEqual({
      help: false,
      campaignId: 'cmp_1',
      campaignName: null,
      apply: true,
      force: true,
      concurrency: 2,
      batchSize: 5,
      yes: true,
      maxReopenedStops: null,
    });
  });

  /**
   * `--help` is answerable on its own. Requiring a campaign to read the usage
   * is how an operator ends up guessing the flag they were trying to look up.
   */
  it('answers --help without a campaign', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('refuses no campaign, and refuses both', () => {
    expect(refusalOf(() => parseArgs([]))).toContain('--campaign');
    expect(refusalOf(() => parseArgs(['--campaign', 'cmp_1', '--campaign-name', 'Diwali']))).toContain(
      'not both',
    );
  });

  /** A flag whose value was forgotten swallows the next flag otherwise, and
   *  the run targets a campaign named `--apply`. */
  it('refuses a valued flag with no value', () => {
    expect(refusalOf(() => parseArgs(['--campaign']))).toContain('--campaign');
    expect(refusalOf(() => parseArgs(['--campaign', '--apply']))).toContain('--campaign');
    expect(refusalOf(() => parseArgs(['--campaign', '']))).toContain('--campaign');
  });

  it('refuses a batch or concurrency that is not a whole number of at least 1', () => {
    expect(refusalOf(() => parseArgs(['--campaign', 'c', '--batch', '0']))).toContain('--batch');
    expect(refusalOf(() => parseArgs(['--campaign', 'c', '--concurrency', 'four']))).toContain(
      '--concurrency',
    );
    expect(refusalOf(() => parseArgs(['--campaign', 'c', '--batch', '2.5']))).toContain('--batch');
  });

  it('refuses an argument it does not know', () => {
    expect(refusalOf(() => parseArgs(['--campaign', 'c', '--dry-run']))).toContain('--dry-run');
  });
});

describe('an argument nobody meant to type', () => {
  /**
   * A stray value is whatever was on the command line, and what is on the
   * command line of a run like this is sometimes a token pasted one line too
   * low. Four characters is enough to recognise it and not enough to be a
   * credential.
   */
  it('shows only enough of a stray value to recognise the typo', () => {
    const message = refusalOf(() => parseArgs(['--campaign', 'cmp_1', 'sk_live_abcdefghijklmnop']));

    expect(message).toContain('sk_l…');
    expect(message).not.toContain('abcdefghijklmnop');
  });

  /** A flag with a value attached might BE the value: `--token=sk_live_…` is
   *  one paste away, and the flag half alone is not worth the risk. */
  it('clips an unknown flag that carries a value', () => {
    const message = refusalOf(() => parseArgs(['--campaign', 'cmp_1', '--token=sk_live_abcdef']));

    expect(message).toContain('--to…');
    expect(message).not.toContain('sk_live_abcdef');
  });

  /** A bare `--flag` carries no value and cannot be a paste of one, so it is
   *  named in full: it is a typo, and hiding it helps nobody. */
  it('names a bare unknown flag in full', () => {
    expect(refusalOf(() => parseArgs(['--campaign', 'cmp_1', '--tokennnnnn']))).toContain(
      '--tokennnnnn',
    );
  });
});

describe('the reopened-stop ceiling', () => {
  it('is off unless it is asked for', () => {
    expect(parseArgs(['--campaign', 'cmp_1']).maxReopenedStops).toBeNull();
  });

  it('is a whole number of at least one', () => {
    expect(parseArgs(['--campaign', 'cmp_1', '--max-reopened-stops', '40']).maxReopenedStops).toBe(40);
    expect(refusalOf(() => parseArgs(['--campaign', 'cmp_1', '--max-reopened-stops', 'lots']))).toContain(
      '--max-reopened-stops',
    );
  });
});

/**
 * The question asked once, before batch one is judged.
 *
 * Every other confirmation in this tool comes after a batch has been judged and
 * an operator has read what it would do. This one comes before anything at all,
 * because the failure it guards against is the one the batch tables cannot
 * catch: a valid campaign that is not the campaign the operator meant. Twenty
 * contacts of it are re-armed before the first table exists.
 */
describe('the prompt before the first batch', () => {
  it('names the campaign it is about to re-arm', () => {
    const question = applyPrompt({ campaignId: 'cmp_1', campaignName: 'Diwali reactivation' });

    expect(question).toContain('Diwali reactivation');
    expect(question).toContain('cmp_1');
    expect(question).toContain('[y/N]');
  });
});

describe('the environment', () => {
  it('reads the five variables and the platform default', () => {
    expect(readConfig(ENV)).toStrictEqual({
      databaseUrl: ENV.DATABASE_URL,
      apiUrl: 'https://api.vocobase.com',
      token: ENV.VOCOBASE_ADMIN_DEBUG_TOKEN,
      sim: { baseUrl: 'https://models.example.com/v1', apiKey: ENV.SIM_API_KEY, model: 'contender-h' },
    });
  });

  it('takes a platform override and trims trailing slashes off both bases', () => {
    const config = readConfig({ ...ENV, VOCOBASE_API_URL: 'http://localhost:3001/', SIM_BASE_URL: 'https://m.example.com/v1//' });

    expect(config.apiUrl).toBe('http://localhost:3001');
    expect(config.sim.baseUrl).toBe('https://m.example.com/v1');
  });

  it('names the one variable that is missing, and only that one', () => {
    for (const name of [
      'DATABASE_URL',
      'VOCOBASE_ADMIN_DEBUG_TOKEN',
      'SIM_BASE_URL',
      'SIM_API_KEY',
      'SIM_MODEL',
    ]) {
      const message = refusalOf(() => readConfig({ ...ENV, [name]: undefined }));

      expect(message).toContain(name);
      expect(message.split('\n')).toHaveLength(1);
    }
  });

  /**
   * The refusal is read off a terminal and pasted into a chat. Two of these
   * five variables are credentials, and a message that quoted the environment
   * back would put them there.
   */
  it('never puts a value in the refusal', () => {
    for (const name of ['DATABASE_URL', 'SIM_MODEL']) {
      const message = refusalOf(() => readConfig({ ...ENV, [name]: undefined }));

      expect(message).not.toContain(ENV.VOCOBASE_ADMIN_DEBUG_TOKEN);
      expect(message).not.toContain(ENV.SIM_API_KEY);
      expect(message).not.toContain('hunter2');
    }
  });
});

describe('a campaign named rather than identified', () => {
  it('offers the ids when the name matches more than one campaign', () => {
    const message = campaignNameError({
      name: 'Diwali',
      matches: [
        { id: 'cmp_1', name: 'Diwali' },
        { id: 'cmp_2', name: 'Diwali' },
      ],
      similar: [],
    });

    expect(message).toContain('2 campaigns are named "Diwali"');
    expect(message).toContain('cmp_1');
    expect(message).toContain('cmp_2');
    expect(message).toContain('--campaign');
  });

  /** A name off by a space is the likely mistake, so the near misses are the
   *  candidates worth printing rather than a bare "not found". */
  it('offers the near misses when nothing matches exactly', () => {
    const message = campaignNameError({
      name: 'Diwali',
      matches: [],
      similar: [{ id: 'cmp_9', name: 'Diwali reactivation' }],
    });

    expect(message).toContain('no campaign is named "Diwali"');
    expect(message).toContain('cmp_9');
    expect(message).toContain('Diwali reactivation');
  });

  it('says so plainly when there is nothing to offer', () => {
    const message = campaignNameError({ name: 'Diwali', matches: [], similar: [] });

    expect(message).toContain('no campaign is named "Diwali"');
    expect(message).not.toContain('cmp_');
  });
});

describe('the header', () => {
  const target = { campaignId: 'cmp_1', campaignName: 'Diwali reactivation' };

  it('names the campaign and states that a dry run writes nothing', () => {
    const header = renderHeader({ ...target, apply: false, batchSize: 20, concurrency: 4, yes: false });

    expect(header).toContain('Diwali reactivation');
    expect(header).toContain('cmp_1');
    expect(header).toContain('DRY RUN');
    expect(header).toContain('20');
    expect(header).toContain('4');
  });

  /** The line an operator must be able to see before a single row is written. */
  it('says that apply writes, and whether it will pause', () => {
    const paused = renderHeader({ ...target, apply: true, batchSize: 5, concurrency: 2, yes: false });

    expect(paused).toContain('APPLY');
    expect(paused).toContain('pause');

    expect(renderHeader({ ...target, apply: true, batchSize: 5, concurrency: 2, yes: true })).toContain(
      'no pause',
    );
  });
});
