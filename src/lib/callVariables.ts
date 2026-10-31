import type { Prisma } from '@prisma/client';

/**
 * The pre-call variable projection, shared by the outbound dialer and the
 * inbound routing-policy handler.
 *
 * Both put the same contact facts on the wire the same way — the outbound
 * dialer at dial time, the inbound handler when a recognised caller rings in —
 * so the projection lives here rather than in either caller, and neither can
 * drift from the other. Every value is a string: the platform's own call-time
 * fields are all strings, so template substitution and the JSON payload stay
 * well-formed.
 */

/** Everything a projection may read: the uploaded columns, and the four the
 *  importer lifted onto columns of their own. */
export interface MappableContact {
  phone: string;
  name: string | null;
  email: string | null;
  tags: string[];
  metadata: unknown;
}

/**
 * The pre-call variables for one contact.
 *
 * Two projections, and which one runs is the campaign's own answer:
 *
 * - **A campaign carrying a `variableMap`** is projected through the map alone.
 *   The map is the operator saying, column by column, which spreadsheet heading
 *   feeds which agent variable — a rename the agent's declared list cannot
 *   express. Running both would put one column on the wire twice.
 * - **A campaign with no map** keeps the declared-list projection, which every
 *   campaign created before mapping existed relies on.
 *
 * `null` is the "no map" state (SQL NULL, per `Campaign.variableMap`). An empty
 * *object* is a map: an operator who cleared every row asked for no variables.
 */
export function variablesFor(
  campaign: { variableMap: Prisma.JsonValue | null },
  agentVariables: unknown,
  contact: MappableContact,
): Record<string, string> {
  const map = campaign.variableMap;

  if (map !== null && typeof map === 'object' && !Array.isArray(map)) {
    return mappedVariables(map as Record<string, unknown>, contact);
  }

  return declaredVariables(agentVariables, contact);
}

/**
 * `{ csvColumn: agentVariable }` resolved against the whole contact.
 *
 * A mapped column the contact has no value for sends an **empty string**, where
 * the declared projection omits it: the operator mapped this column, so the
 * prompt references the variable, and a variable the prompt names but the
 * payload omits is an upstream error rather than a quietly shorter request.
 *
 * The source is metadata PLUS the four columns the importer lifted out of it,
 * with the contact's own columns winning over a metadata key of the same name.
 */
export function mappedVariables(
  map: Record<string, unknown>,
  contact: MappableContact,
): Record<string, string> {
  const source: Record<string, unknown> = {
    ...(contact.metadata && typeof contact.metadata === 'object' && !Array.isArray(contact.metadata)
      ? (contact.metadata as Record<string, unknown>)
      : {}),
    phone: contact.phone,
    name: contact.name,
    email: contact.email,
    // Joined rather than stringified through `String([...])`, which renders
    // "vip,lapsed" — a list read aloud by an agent wants the space.
    tags: contact.tags.length > 0 ? contact.tags.join(', ') : null,
  };

  const variables: Record<string, string> = {};

  for (const [column, variable] of Object.entries(map)) {
    // The stored map is validated on write, but it is JSON in a column and this
    // runs on every dial: a row that predates the validator must not put a
    // `[object Object]` key on the wire.
    if (typeof variable !== 'string' || variable === '') continue;

    const value = source[column];

    variables[variable] = value === undefined || value === null ? '' : String(value);
  }

  return variables;
}

/**
 * The legacy projection: the agent's declared names, as an allow-list.
 *
 * The platform requires that variable keys match the agent's own names, and a
 * contact's `metadata` is every CSV column the customer happened to upload, so
 * the agent's declared list is the allow-list — a spreadsheet column the prompt
 * never references does not put arbitrary customer data on the wire.
 */
export function declaredVariables(
  agentVariables: unknown,
  contact: MappableContact,
): Record<string, string> {
  const declared = Array.isArray(agentVariables)
    ? agentVariables.filter((v): v is string => typeof v === 'string')
    : [];
  if (declared.length === 0) return {};

  const source: Record<string, unknown> = {
    ...(contact.metadata && typeof contact.metadata === 'object'
      ? (contact.metadata as Record<string, unknown>)
      : {}),
    ...(contact.name === null ? {} : { name: contact.name }),
  };

  const variables: Record<string, string> = {};

  for (const key of declared) {
    const value = source[key];
    // Missing values render as empty strings upstream and are never an error,
    // so an absent column is simply omitted rather than sent as "undefined".
    if (value === undefined || value === null) continue;

    variables[key] = typeof value === 'string' ? value : String(value);
  }

  return variables;
}
