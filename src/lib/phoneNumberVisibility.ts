import type { PhoneNumberStatus, Prisma } from '@prisma/client';

/**
 * The two statuses that mean "this workspace holds this number".
 *
 * `PAST_DUE` is on the list on purpose, and the enum's own comment is the
 * argument: the DID still belongs to them and still rings, and the renewal
 * sweep is still retrying. Refusing to configure with it would punish a billing
 * state that has not yet taken the number away — and worse, it would let a
 * declined card silently unpick the caller id of a campaign nobody edited.
 *
 * `UNASSIGNED` and `RELEASED_NONPAYMENT` both mean the number is back in the
 * shared pool, and a pool number belongs to nobody. They differ only in
 * carrying the reason it became free, which is not a distinction a campaign has
 * any use for.
 *
 * Deliberately NOT expressed by reusing `agentIsUsable`. The two rules are the
 * same shape and different content — an agent turns on a free-text `status`
 * that may be null, a number on a closed enum that never is — and one function
 * that accepted either would be one that could be handed the wrong rule with
 * nothing to catch it.
 */
export const HELD_STATUSES: readonly PhoneNumberStatus[] = ['ASSIGNED', 'PAST_DUE'];

/**
 * The SQL half, for a number that has not been read yet.
 *
 * Shared with the in-memory half below rather than spelled out at each call
 * site: there are two places that must agree on what makes a number usable —
 * the assignment check and the serializer — and a rule written twice is a rule
 * that eventually says two different things. That is exactly the drift
 * `agentVisibility.ts` was written to prevent on the agent side.
 */
export const IS_HELD: Prisma.PhoneNumberWhereInput = { status: { in: [...HELD_STATUSES] } };

/**
 * The in-memory half of the same rule, for a row already joined.
 *
 * Two conditions, both necessary, neither implied by `phoneNumberId != null`:
 *
 * - **Still this workspace's.** A release sets `workspaceId` back to null, an
 *   UPDATE the foreign key cannot see, so a campaign can hold a perfectly valid
 *   id for a number that is now in the pool — or rented by somebody else.
 * - **Still held.** Today's release path also clears `workspaceId`, so the
 *   ownership check alone would happen to catch a released number. That is a
 *   coincidence of one writer, not a property of the schema: `status` and
 *   `workspaceId` are two columns that must agree, and nothing in the database
 *   makes them. Checking the one that actually names the state means this rule
 *   does not quietly depend on every future release path remembering to clear
 *   the other.
 */
export function phoneNumberIsUsable(
  number: { status: PhoneNumberStatus; workspaceId: string | null } | null | undefined,
  workspaceId: string,
): boolean {
  if (!number) return false;
  if (number.workspaceId !== workspaceId) return false;
  return HELD_STATUSES.includes(number.status);
}
