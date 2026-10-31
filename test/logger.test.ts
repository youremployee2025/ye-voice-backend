import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import {
  buildLoggerOptions,
  buildTransportTargets,
  maskDeep,
  maskPhones,
  requestPath,
} from '../src/lib/logger.js';

/**
 * Runs a real pino through the production options against an in-memory
 * stream, so what is asserted is the line that would have reached Axiom —
 * not a re-implementation of the redaction in the test.
 *
 * Deliberately not the exported `logger`: that one owns transports (worker
 * threads, a live Axiom connection) and a level that varies with the
 * environment. The options object is the part under test.
 */
function capture(emit: (log: pino.Logger) => void): Record<string, unknown> {
  const lines: Record<string, unknown>[] = [];
  const stream = {
    write(chunk: string) {
      lines.push(JSON.parse(chunk) as Record<string, unknown>);
    },
  };

  emit(pino({ ...buildLoggerOptions(), level: 'trace' }, stream));

  expect(lines).toHaveLength(1);
  return lines[0];
}

describe('maskPhones — free text', () => {
  it('masks an E.164 number, keeping the last four digits', () => {
    expect(maskPhones('Could not release DID +14155550142')).toBe(
      'Could not release DID +*******0142',
    );
  });

  it('masks every number in a message, not just the first', () => {
    expect(maskPhones('transfer +919876543210 -> +14155550142')).toBe(
      'transfer +********3210 -> +*******0142',
    );
  });

  it('masks a number written with separators, collapsing them', () => {
    expect(maskPhones('called +1 (415) 555-0142 twice')).toBe('called +*******0142 twice');
  });

  it('masks a bare digit run of phone length, such as an upstream query param', () => {
    expect(maskPhones('GET /call-metadata?from=919484957112')).toBe(
      'GET /call-metadata?from=********7112',
    );
  });

  /**
   * The masker is deliberately blunt on free text, so the things it must NOT
   * eat are pinned. A cuid or uuid carries digits but is never a bare run; a
   * short number is a count, a port, a status or a credit amount, and masking
   * those would gut the logs to no benefit.
   */
  it('leaves identifiers and short numbers alone', () => {
    const line =
      'campaign cmb2xk9q0000abcd1234 status=200 in 142ms, 25 calls, charged 1.50 credits';
    expect(maskPhones(line)).toBe(line);
  });

  it('does not mask a digit run embedded in a longer word-character token', () => {
    expect(maskPhones('attempt id a919484957112b')).toBe('attempt id a919484957112b');
  });
});

describe('maskDeep — structured arguments', () => {
  it('masks a phone-shaped string nested in an object', () => {
    expect(maskDeep({ contact: { number: '+14155550142' } })).toEqual({
      contact: { number: '+*******0142' },
    });
  });

  it('redacts a value under a sensitive key whatever its type', () => {
    expect(maskDeep({ transcript: 'the caller said their card number is ...' })).toEqual({
      transcript: '[Redacted]',
    });
    // A number cannot be phone-masked without destroying counts and durations,
    // so numeric PII is caught by the key name instead.
    expect(maskDeep({ phone: 919484957112 })).toEqual({ phone: '[Redacted]' });
  });

  it('walks arrays', () => {
    expect(maskDeep({ numbers: ['+14155550142', '+919876543210'] })).toEqual({
      numbers: ['+*******0142', '+********3210'],
    });
  });

  it('leaves ordinary values untouched', () => {
    const payload = { campaignId: 'cmb2xk9q0000abcd1234', queued: 25, ok: true, at: null };
    expect(maskDeep(payload)).toEqual(payload);
  });
});

describe('the line that reaches Axiom', () => {
  it('redacts the Authorization header', () => {
    const line = capture((log) =>
      log.info({ req: { headers: { authorization: 'Bearer sk_live_deadbeef' } } }, 'req'),
    );
    expect(JSON.stringify(line)).not.toContain('sk_live_deadbeef');
  });

  it('redacts the webhook signature and the staff token headers', () => {
    const line = capture((log) =>
      log.info(
        {
          req: {
            headers: {
              'x-webhook-signature': 'v1=9c1185a5c5e9fc54612808977ee8f548b2258d31',
              'x-admin-token': 'staff-token-value',
            },
          },
        },
        'req',
      ),
    );
    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain('9c1185a5c5e9fc54612808977ee8f548b2258d31');
    expect(serialized).not.toContain('staff-token-value');
  });

  /**
   * The webhook processor is where a raw transcript would leak: the delivery
   * carries the whole session, and any handler that logged `data` on a bad
   * event would ship it verbatim.
   */
  it('masks a webhook payload carrying a transcript, extraction and a recording url', () => {
    const line = capture((log) =>
      log.info(
        {
          event: 'session.completed',
          data: {
            call: { call_id: 'call_123', to_number: '+919484957112' },
            transcript: [{ role: 'user', content: 'my account number is 4444 3333 2222' }],
            extraction: { values: { name: 'A real person', callback_at: 'tomorrow 4pm' } },
            recording_url: 'https://recordings.example.com/abc.mp3?sig=secret',
          },
        },
        'webhook received',
      ),
    );

    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain('my account number');
    expect(serialized).not.toContain('A real person');
    expect(serialized).not.toContain('recordings.example.com');
    expect(serialized).not.toContain('919484957112');
    // The non-sensitive half of the same payload survives, or the logs are useless.
    expect(serialized).toContain('call_123');
    expect(serialized).toContain('session.completed');
  });

  it('masks a phone number interpolated into the message itself', () => {
    const line = capture((log) => log.warn('Could not mirror DID +919484957112'));
    expect(line.msg).toBe('Could not mirror DID +********7112');
  });

  it('masks a phone number in a logged request url', () => {
    const line = capture((log) =>
      log.info({ req: { method: 'GET', url: '/api/calls?from=919484957112' } }, 'GET /api/calls'),
    );
    expect(JSON.stringify(line)).not.toContain('919484957112');
  });

  it('redacts the extraction value the callback logger reports', () => {
    const line = capture((log) =>
      log.info({ extractionValue: 'call me back on Tuesday' }, '[callback] contact abc: booked'),
    );
    expect(JSON.stringify(line)).not.toContain('Tuesday');
  });

  it('keeps the service and environment bindings', () => {
    const line = capture((log) => log.info('up'));
    expect(line.service).toBe('ye-voice-backend');
    expect(line.environment).toBeTypeOf('string');
  });
});

describe('requestPath', () => {
  /**
   * Every route in this app is behind a mount, and the request log is written
   * when the response finishes — by which point Express has rewritten
   * `req.url` for the router that handled it. Reading `url` there labels
   * `/api/me` as `/me` and `/webhooks/vocobase` as `/vocobase`.
   */
  it('reports the path the caller sent, not the mount-stripped one', () => {
    expect(requestPath({ originalUrl: '/api/me', url: '/me' })).toBe('/api/me');
    expect(requestPath({ originalUrl: '/webhooks/vocobase', url: '/vocobase' })).toBe(
      '/webhooks/vocobase',
    );
  });

  it('falls back to url when there is no originalUrl', () => {
    expect(requestPath({ url: '/health' })).toBe('/health');
    expect(requestPath({})).toBe('');
  });

  it('masks a phone number in the query string', () => {
    expect(requestPath({ originalUrl: '/api/calls?from=919484957112' })).toBe(
      '/api/calls?from=********7112',
    );
  });
});

describe('transports build in both modes', () => {
  it('development gets pretty output and nothing else', () => {
    const { targets, warning } = buildTransportTargets({
      isProduction: false,
      logLevel: 'debug',
    });

    expect(targets.map((t) => t.target)).toEqual(['pino-pretty']);
    expect(warning).toBeNull();
  });

  it('production ships to stdout and to Axiom when both are configured', () => {
    const { targets, warning } = buildTransportTargets({
      isProduction: true,
      logLevel: 'info',
      axiomToken: 'xaat-token',
      axiomDataset: 'ye-voice-backend',
    });

    expect(targets.map((t) => t.target)).toEqual(['pino/file', '@axiomhq/pino']);
    expect(targets[1].options).toMatchObject({
      dataset: 'ye-voice-backend',
      token: 'xaat-token',
    });
    expect(warning).toBeNull();
  });

  it('passes the region edge through only when one is set', () => {
    const withEdge = buildTransportTargets({
      isProduction: true,
      logLevel: 'info',
      axiomToken: 't',
      axiomDataset: 'd',
      axiomEdge: 'eu-central-1.aws.edge.axiom.co',
    });
    expect(withEdge.targets[1].options).toMatchObject({
      edge: 'eu-central-1.aws.edge.axiom.co',
    });

    const withoutEdge = buildTransportTargets({
      isProduction: true,
      logLevel: 'info',
      axiomToken: 't',
      axiomDataset: 'd',
    });
    expect(withoutEdge.targets[1].options).not.toHaveProperty('edge');
  });

  /**
   * The point of the whole exercise: a missing token is a warning and stdout,
   * never a crash. Logging configuration must not be able to take the API down.
   */
  it('production without Axiom credentials still logs to stdout, and warns', () => {
    const { targets, warning } = buildTransportTargets({
      isProduction: true,
      logLevel: 'info',
    });

    expect(targets.map((t) => t.target)).toEqual(['pino/file']);
    expect(warning).toMatch(/AXIOM_TOKEN/);
  });

  it('treats a half-configured Axiom as unconfigured', () => {
    const { targets, warning } = buildTransportTargets({
      isProduction: true,
      logLevel: 'info',
      axiomToken: 'xaat-token',
    });

    expect(targets.map((t) => t.target)).toEqual(['pino/file']);
    expect(warning).not.toBeNull();
  });
});

/**
 * The ordering hazard that makes Axiom silently do nothing.
 *
 * `app.ts` imports this module before anything that logs, which means before
 * `env.ts` — and `env.ts` is where `dotenv.config()` used to run for the whole
 * process. Reading `AXIOM_TOKEN` at that point finds nothing on a deployment
 * that configured it in `.env`: the boot warning prints, stdout carries every
 * line, and nothing anywhere looks wrong. The logs just never arrive.
 *
 * It cannot be tested in-process, because vitest's own setup has already
 * loaded `.env` by the time any test body runs. So this spawns a fresh process
 * whose only configuration is a `.env` file, and imports the logger alone.
 */
describe('configuration does not depend on another module loading .env first', () => {
  it('resolves Axiom from .env when nothing else has loaded it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ezo-logger-'));

    try {
      writeFileSync(
        join(dir, '.env'),
        'AXIOM_TOKEN=xaat-from-dotenv\nAXIOM_DATASET=ezo-from-dotenv\n',
      );

      const loggerModule = pathToFileURL(resolve('src/lib/logger.ts')).href;
      const stdout = execFileSync(
        resolve('node_modules/.bin/tsx'),
        [
          '-e',
          `import(${JSON.stringify(loggerModule)}).then((m) =>
             process.stdout.write(JSON.stringify(m.loggingConfig)))`,
        ],
        {
          cwd: dir,
          encoding: 'utf8',
          // A clean environment, or the repo's own .env leaks in through the
          // parent process and the test proves nothing.
          env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
        },
      );

      const config = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as {
        shipsToAxiom: boolean;
        dataset: string | null;
      };

      expect(config.shipsToAxiom).toBe(true);
      expect(config.dataset).toBe('ezo-from-dotenv');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * Both entry points, not just the API one.
 *
 * `worker.ts` runs the DID renewal sweep and the dialer, which are the two
 * loudest sources of phone numbers in this codebase — the renewal sweep names
 * a DID in every line it writes. In a split deployment
 * (`WORKERS_ENABLED=false` beside a worker process) that half would log
 * unstructured, unmasked and unshipped if it never imported the logger.
 */
describe('both entry points install the logger', () => {
  async function source(file: string): Promise<string> {
    const { readFile } = await import('node:fs/promises');
    return readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
  }

  it('app.ts imports the logger before anything that logs', async () => {
    const text = await source('app.ts');
    const logger = text.indexOf("from './lib/logger.js'");
    const express = text.indexOf("from 'express'");

    expect(logger).toBeGreaterThan(-1);
    expect(logger).toBeLessThan(express);
  });

  it('worker.ts imports the logger before the workers it starts', async () => {
    const text = await source('worker.ts');
    const logger = text.indexOf("'./lib/logger.js'");
    // The sweeps are BullMQ workers now rather than timers, and this file is
    // the one line that composes them. The rule is unchanged and is the reason
    // it is asserted on the *import order*: the console override has to be
    // installed before any module that logs is loaded, and every one of those
    // modules arrives through the bootstrap below.
    const bootstrap = text.indexOf('startWorkers');

    expect(logger).toBeGreaterThan(-1);
    expect(bootstrap).toBeGreaterThan(-1);
    expect(logger).toBeLessThan(bootstrap);
  });
});
