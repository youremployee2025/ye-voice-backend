/**
 * The model call that produces one re-extraction, and nothing else.
 *
 * This is the simulator's client with everything the simulator needed and
 * this run does not — tools, token accounting, recordings, a concurrency
 * semaphore — left out, because the run pools its own concurrency per batch.
 * What is kept is exactly the behaviour that made contender H measurable
 * against a real endpoint: `temperature: 0`, JSON mode, a bounded retry on
 * the transient statuses, and the one-shot fallback for endpoints that have
 * no JSON mode at all.
 *
 * Plain `fetch`, no SDK: the request is a dozen lines, and an SDK brings its
 * own retry policy and its own logging, the second of which is how an API key
 * ends up in a run report.
 */
import type { ChatMessage } from './messages.js';

export interface CompleterOptions {
  /** OpenAI-compatible base, e.g. `https://…/v1`; `/chat/completions` is appended. */
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  /** Injected so the retry tests do not wait out real back-off. */
  sleep?: (ms: number) => Promise<void>;
}

export type Completer = (messages: ChatMessage[]) => Promise<string>;

/** Four back-offs, so five attempts in all. */
const BACKOFF_MS = [1000, 2000, 4000, 8000];

/**
 * Longest `retry-after` honoured. Some proxies answer a burst with an hour;
 * waiting that out would stall a thousand-contact run silently, whereas a
 * minute covers any real rate window and a second 429 is still retried.
 */
const MAX_RETRY_AFTER_MS = 60_000;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 429 and anything the endpoint blames on itself. */
function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

/** What the endpoint asked us to wait, or the ladder's next rung. */
function waitFor(res: Response, retries: number): number {
  const header = res.headers.get('retry-after');
  const seconds = header === null ? Number.NaN : Number(header);

  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);

  return BACKOFF_MS[retries];
}

interface ChatCompletionBody {
  choices?: Array<{ message?: { content?: string | null } }>;
}

/**
 * Bind an endpoint, a key and a model into `messages -> text`.
 *
 * The returned function throws rather than returning a sentinel on failure:
 * the caller records the failure against that one conversation and moves to
 * the next, and a re-extraction that silently returned an empty string would
 * be recorded as an unreadable reply from a model that was never reached.
 */
export function createCompleter(options: CompleterOptions): Completer {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? realSleep;
  const url = `${options.baseUrl}/chat/completions`;

  return async function complete(messages: ChatMessage[]): Promise<string> {
    let json = true;
    let retries = 0;

    for (;;) {
      const body: Record<string, unknown> = { model: options.model, messages, temperature: 0 };

      if (json) body.response_format = { type: 'json_object' };

      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      const text = await res.text();

      if (res.ok) {
        let parsed: unknown;

        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = null;
        }

        const choices = (parsed as ChatCompletionBody | null)?.choices;

        /**
         * A 2xx that is not a completion — a proxy's login page, a CDN's HTML
         * error — must not read as "the model said nothing": that answer
         * would be filed as an unreadable reply against a call whose dump was
         * perfectly good.
         */
        if (!Array.isArray(choices) || choices.length === 0) {
          throw new Error(`model: 200 with no choices from ${url}: ${text.slice(0, 200)}`);
        }

        const content = choices[0]?.message?.content;

        return typeof content === 'string' ? content : '';
      }

      if (isTransient(res.status) && retries < BACKOFF_MS.length) {
        await sleep(waitFor(res, retries));
        retries += 1;
        continue;
      }

      /**
       * Some OpenAI-compatible endpoints have no JSON mode and reject the
       * request outright. Dropping `response_format` and asking again gets the
       * same content from a model the prompt already told to answer in JSON,
       * and the parser downstream is strict either way. Once only, so an
       * endpoint that keeps naming it surfaces rather than looping.
       */
      if (res.status === 400 && json && text.includes('response_format')) {
        json = false;
        continue;
      }

      const attempts = retries + 1;

      throw new Error(
        `model: ${res.status} from ${url} after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${text.slice(0, 200)}`,
      );
    }
  };
}
