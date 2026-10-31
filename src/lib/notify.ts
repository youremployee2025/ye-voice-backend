import type { NotificationScope } from '@prisma/client';
import { prisma } from './prisma.js';

/** Writes started but not yet settled. Exists so tests can wait for one. */
const inFlight = new Set<Promise<void>>();

/**
 * Keeps `href` to an in-app path, which is what every reader of the column
 * assumes it is: the dashboard feeds it straight to the router.
 *
 * Every call site today passes a literal, so nothing is currently wrong — but
 * "never an absolute URL" was an invariant asserted in three documents and
 * enforced in none, and the emitter that first builds an href out of user
 * input is the one that turns that into an open redirect. Checked here rather
 * than at each call site because here is the only place all of them pass.
 *
 * A rejected href is dropped, not thrown: a notification with no link is a
 * degraded notification, while a throw would violate this module's one hard
 * promise — that it never fails the action that triggered it.
 *
 * `//evil.example` is protocol-relative and navigates off-site despite the
 * leading slash, so a `startsWith('/')` test alone is not enough.
 */
function inAppPath(href: string | undefined): string | null {
  if (!href) return null;

  if (!href.startsWith('/') || href.startsWith('//') || href.startsWith('/\\')) {
    console.error(`[notify] refusing a non-relative href, dropping it: ${href}`);
    return null;
  }

  return href;
}

/**
 * Records something that has already happened inside a workspace.
 *
 * Fire-and-forget: call sites write `void notify(...)` and never await. The
 * returned promise **always resolves** — every failure is caught, logged and
 * dropped — because a notification is a side effect of an action that has
 * already succeeded. Letting the bell fail an invite acceptance, or roll back
 * a campaign that is now running, is never the right trade, and the only way
 * to be sure of that is for the failure path to be unreachable from the
 * caller's stack.
 *
 * The whole body sits inside the async IIFE deliberately, so `notify` cannot
 * throw synchronously either: `void notify(...)` swallows a rejected promise
 * but not a throw during construction.
 */
export function notify(
  workspaceId: string,
  scope: NotificationScope,
  type: string,
  title: string,
  body: string,
  href?: string,
): Promise<void> {
  const write = (async () => {
    try {
      await prisma.notification.create({
        data: { workspaceId, scope, type, title, body, href: inAppPath(href) },
      });
    } catch (err) {
      // Terminal on purpose. Nothing upstream can act on this, and rethrowing
      // would put it back in the request path this function exists to protect.
      console.error(`[notify] could not record ${type} for workspace ${workspaceId}:`, err);
    }
  })();

  inFlight.add(write);
  void write.finally(() => inFlight.delete(write));

  return write;
}

/**
 * Test-only: awaits every write started so far.
 *
 * Production code never calls this — the point of the emitter is that nothing
 * waits for it. Route tests need it because the response can return before the
 * row lands, and the alternative is a sleep that is either flaky or slow.
 */
export async function flushNotifications(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.all([...inFlight]);
  }
}
