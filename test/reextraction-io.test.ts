import { describe, expect, it } from 'vitest';
import { fetchDump } from '../src/lib/reextraction/dump.js';
import { createCompleter } from '../src/lib/reextraction/model.js';
import type { ChatMessage } from '../src/lib/reextraction/messages.js';
import { ReextractionRefused, ReextractionSkip } from '../src/lib/reextraction/skip.js';

/** A token and a key no assertion may ever find in a message the run prints. */
const TOKEN = 'debug-token-do-not-print';
const KEY = 'sk-secret-do-not-print';

interface Call {
  url: string;
  init: RequestInit;
}

/**
 * A `fetch` that answers from a queue and files what it was asked.
 *
 * Every case here injects one of these: the two clients are the only parts of
 * the run that touch a network, and a test that reached a real one would be
 * testing the endpoint's mood rather than the client.
 */
function stubFetch(responses: Array<() => Response>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let next = 0;

  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });

    const make = responses[next];

    if (!make) throw new Error(`stub fetch: no response queued for call ${next + 1}`);

    next += 1;

    return make();
  };

  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const json = (body: unknown, init: ResponseInit = {}): (() => Response) => {
  return () => new Response(JSON.stringify(body), { status: 200, ...init });
};

function headerOf(call: Call, name: string): string | undefined {
  const headers = call.init.headers as Record<string, string> | undefined;

  return headers?.[name];
}

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ dump */

const SESSION = {
  transcript: [
    { role: 'assistant', content: 'Hello, this is Vocobase.' },
    { role: 'user', content: 'Call me Tuesday.' },
  ],
  promptSnapshot: { renderedPrompt: 'You are an agent.' },
  startedAt: '2026-09-04T04:25:00.000Z',
  endedAt: '2026-09-04T04:30:00.000Z',
};

const dumpBody = (session: unknown): unknown => ({
  sessionId: 's-1',
  matchedBy: 'sessionId',
  session,
  issues: [],
  webhooks: [],
  creditTxns: [],
  botLogLines: [],
});

describe('fetching one session dump', () => {
  it('reads the transcript, the prompt and when the call ended', async () => {
    const { fetchImpl, calls } = stubFetch([json(dumpBody(SESSION))]);

    const dump = await fetchDump('s-1', { apiUrl: 'https://api.example.com', token: TOKEN, fetchImpl });

    expect(dump.transcript).toEqual([
      { role: 'assistant', content: 'Hello, this is Vocobase.' },
      { role: 'user', content: 'Call me Tuesday.' },
    ]);
    expect(dump.systemPrompt).toBe('You are an agent.');
    expect(dump.endedAt.toISOString()).toBe('2026-09-04T04:30:00.000Z');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example.com/api/admin/sessions/s-1/dump?format=json');
    expect(headerOf(calls[0], 'X-Debug-Token')).toBe(TOKEN);
  });

  /** A `providerCallSid` is accepted by the endpoint too, and those carry
   *  characters a path segment may not. */
  it('encodes the session id into the path', async () => {
    const { fetchImpl, calls } = stubFetch([json(dumpBody(SESSION))]);

    await fetchDump('sid/with?chars', { apiUrl: 'https://api.example.com', token: TOKEN, fetchImpl });

    expect(calls[0].url).toBe('https://api.example.com/api/admin/sessions/sid%2Fwith%3Fchars/dump?format=json');
  });

  /**
   * The dump names a turn's side and its words differently depending on which
   * table the row came from. Reading only `role`/`content` would drop half a
   * conversation silently, and a half conversation still extracts — into a
   * verdict about a call that was never had.
   */
  it('reads a turn however the dump named its fields', async () => {
    const { fetchImpl } = stubFetch([
      json(
        dumpBody({
          ...SESSION,
          transcript: [
            { speaker: 'bot', text: 'Hello.' },
            { type: 'customer', message: 'Not interested.' },
            'a string, not a turn',
            null,
            { role: 'assistant', content: 'Understood.' },
          ],
        }),
      ),
    ]);

    const dump = await fetchDump('s-1', { apiUrl: 'https://api.example.com', token: TOKEN, fetchImpl });

    expect(dump.transcript).toEqual([
      { role: 'bot', content: 'Hello.' },
      { role: 'customer', content: 'Not interested.' },
      { role: 'assistant', content: 'Understood.' },
    ]);
  });

  it('falls back to the older prompt field and to the start time', async () => {
    const { fetchImpl } = stubFetch([
      json(
        dumpBody({
          transcript: SESSION.transcript,
          promptSnapshot: { prompt: 'An older snapshot.' },
          startedAt: '2026-09-04T04:25:00.000Z',
          endedAt: null,
        }),
      ),
    ]);

    const dump = await fetchDump('s-1', { apiUrl: 'https://api.example.com', token: TOKEN, fetchImpl });

    expect(dump.systemPrompt).toBe('An older snapshot.');
    expect(dump.endedAt.toISOString()).toBe('2026-09-04T04:25:00.000Z');
  });
});

describe('a dump this run cannot judge', () => {
  const skipOf = async (make: () => Response): Promise<string> => {
    const { fetchImpl } = stubFetch([make]);

    try {
      await fetchDump('s-1', { apiUrl: 'https://api.example.com', token: TOKEN, fetchImpl });
    } catch (err) {
      if (err instanceof ReextractionSkip) return err.reason;

      throw err;
    }

    throw new Error('expected a skip');
  };

  /** Sessions older than `SESSION_LOG_RETENTION_DAYS` are pruned; the run
   *  walks past them rather than stopping on the first one. */
  it('skips a session the platform no longer has', async () => {
    expect(await skipOf(() => new Response('not found', { status: 404 }))).toBe('session_not_found');
  });

  it('skips a dump with no prompt snapshot', async () => {
    expect(await skipOf(json(dumpBody({ ...SESSION, promptSnapshot: null })))).toBe('no_prompt_snapshot');
    expect(await skipOf(json(dumpBody({ ...SESSION, promptSnapshot: { renderedPrompt: '   ' } })))).toBe(
      'no_prompt_snapshot',
    );
  });

  it('skips a dump with no transcript', async () => {
    const { transcript: _dropped, ...noTranscript } = SESSION;

    expect(await skipOf(json(dumpBody(noTranscript)))).toBe('no_transcript');
    expect(await skipOf(json(dumpBody({ ...SESSION, transcript: 'none' })))).toBe('no_transcript');
  });

  /** Without a moment to resolve "next Tuesday" against, the extraction would
   *  book a callback into a week the conversation never mentioned. */
  it('skips a dump that says when nothing ended', async () => {
    expect(await skipOf(json(dumpBody({ ...SESSION, startedAt: null, endedAt: null })))).toBe('no_ended_at');
    expect(await skipOf(json(dumpBody({ ...SESSION, startedAt: 'whenever', endedAt: 'whenever' })))).toBe(
      'no_ended_at',
    );
  });
});

describe('a session dump that fails outright', () => {
  /**
   * A 500 or a 401 is not a fact about the call, it is a fact about the run:
   * one wrong token would otherwise be reported as a thousand conversations
   * that could not be judged, and the operator would believe it.
   */
  it('throws rather than skipping, and never names the token', async () => {
    const { fetchImpl } = stubFetch([() => new Response('upstream exploded', { status: 500 })]);

    const failure = await fetchDump('s-1', { apiUrl: 'https://api.example.com', token: TOKEN, fetchImpl }).catch(
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ReextractionSkip);
    expect((failure as Error).message).toContain('500');
    expect((failure as Error).message).not.toContain(TOKEN);
  });

  /**
   * A 401 or a 403 is a fact about the credential, and it is the same fact for
   * every session. Reported per row it would read as a thousand calls that
   * could not be judged; thrown as a refusal it stops the run on the first one,
   * whatever the batch size, and the operator fixes the token.
   */
  it.each([401, 403])('refuses the whole run on a %s', async (status) => {
    const { fetchImpl } = stubFetch([() => new Response('nope', { status })]);

    const failure = await fetchDump('s-1', {
      apiUrl: 'https://api.example.com',
      token: TOKEN,
      fetchImpl,
    }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ReextractionRefused);
    expect((failure as ReextractionRefused).reason).toBe('dump_unauthorized');
    expect((failure as Error).message).not.toContain(TOKEN);
  });

  it('throws when the dump is not JSON at all', async () => {
    const { fetchImpl } = stubFetch([() => new Response('<html>login</html>', { status: 200 })]);

    await expect(fetchDump('s-1', { apiUrl: 'https://api.example.com', token: TOKEN, fetchImpl })).rejects.toThrow(
      /dump/i,
    );
  });
});

/* ----------------------------------------------------------------- model */

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You are an agent.' },
  { role: 'user', content: 'Judge the call.' },
];

const reply = (content: string): (() => Response) => json({ choices: [{ message: { content } }] });

/** A sleep that records what it was asked to wait rather than waiting. */
function stubSleep(): { sleep: (ms: number) => Promise<void>; slept: number[] } {
  const slept: number[] = [];

  return { sleep: async (ms: number) => void slept.push(ms), slept };
}

function completerOver(
  responses: Array<() => Response>,
): { complete: (messages: ChatMessage[]) => Promise<string>; calls: Call[]; slept: number[] } {
  const { fetchImpl, calls } = stubFetch(responses);
  const { sleep, slept } = stubSleep();

  const complete = createCompleter({
    baseUrl: 'https://model.example.com/v1',
    apiKey: KEY,
    model: 'contender-h',
    fetchImpl,
    sleep,
  });

  return { complete, calls, slept };
}

describe('asking the model for one verdict', () => {
  it('posts the messages and returns the reply', async () => {
    const { complete, calls } = completerOver([reply('{"call_outcome_vocobaseplatform":"stop"}')]);

    expect(await complete(MESSAGES)).toBe('{"call_outcome_vocobaseplatform":"stop"}');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://model.example.com/v1/chat/completions');
    expect(calls[0].init.method).toBe('POST');
    expect(headerOf(calls[0], 'authorization')).toBe(`Bearer ${KEY}`);
    expect(headerOf(calls[0], 'content-type')).toBe('application/json');
    expect(bodyOf(calls[0])).toEqual({
      model: 'contender-h',
      messages: MESSAGES,
      temperature: 0,
      response_format: { type: 'json_object' },
    });
  });

  /** The endpoint knows its own rate window better than a fixed ladder does. */
  it('waits exactly as long as a 429 asked for', async () => {
    const { complete, calls, slept } = completerOver([
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }),
      reply('{}'),
    ]);

    expect(await complete(MESSAGES)).toBe('{}');
    expect(slept).toEqual([7000]);
    expect(calls).toHaveLength(2);
  });

  it('backs off from one second when nothing said how long to wait', async () => {
    const { complete, slept } = completerOver([() => new Response('boom', { status: 503 }), reply('{}')]);

    expect(await complete(MESSAGES)).toBe('{}');
    expect(slept).toEqual([1000]);
  });

  /**
   * Five attempts and then the row fails, rather than a run that retries a
   * dead endpoint a thousand times over.
   */
  it('gives up after five attempts, without naming the key', async () => {
    const failing = () => new Response('still broken', { status: 500 });
    const { complete, calls, slept } = completerOver([failing, failing, failing, failing, failing]);

    const failure = await complete(MESSAGES).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('500');
    expect((failure as Error).message).not.toContain(KEY);
    expect(calls).toHaveLength(5);
    expect(slept).toEqual([1000, 2000, 4000, 8000]);
  });

  /**
   * Some OpenAI-compatible endpoints have no JSON mode and reject the request
   * outright. The prompt asks for JSON anyway and the parser downstream is
   * strict, so the ask is dropped and the question put again — once, so an
   * endpoint that keeps complaining is heard.
   */
  it('drops the JSON-mode ask once when the endpoint rejects it', async () => {
    const rejects = () => new Response('unsupported parameter: response_format', { status: 400 });
    const { complete, calls, slept } = completerOver([rejects, reply('{}')]);

    expect(await complete(MESSAGES)).toBe('{}');
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([]);
    expect(bodyOf(calls[0])).toHaveProperty('response_format');
    expect(bodyOf(calls[1])).not.toHaveProperty('response_format');
  });

  it('surfaces a second complaint about response_format', async () => {
    const rejects = () => new Response('unsupported parameter: response_format', { status: 400 });
    const { complete, calls } = completerOver([rejects, rejects]);

    await expect(complete(MESSAGES)).rejects.toThrow('400');
    expect(calls).toHaveLength(2);
  });

  it('does not retry a 400 that is about something else', async () => {
    const { complete, calls } = completerOver([() => new Response('bad messages', { status: 400 })]);

    await expect(complete(MESSAGES)).rejects.toThrow('400');
    expect(calls).toHaveLength(1);
  });

  /**
   * A 200 that is not a completion — a proxy's login page, a CDN's error —
   * must not read as "the model answered nothing", which downstream would
   * become an unreadable reply rather than a run that stopped on a broken
   * endpoint.
   */
  it('refuses a 200 that carries no choices', async () => {
    const { complete } = completerOver([json({ error: 'no model' })]);

    const failure = await complete(MESSAGES).catch((err: unknown) => err);

    expect((failure as Error).message).toMatch(/no choices/i);
    expect((failure as Error).message).not.toContain(KEY);
  });
});
