# Campaigns (Backend) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add workspace-scoped campaigns, contacts, and CSV contact upload to `ye-voice-backend`, with guarded lifecycle transitions and strict per-workspace isolation, as described in `2026-08-26-campaigns-design.md`.

**Architecture:** Three new Prisma models hanging off `Workspace`, one route module mounted under the existing `requireAuth` + `requireMembership` middleware, and two small libraries — a phone canonicalizer and a CSV contact parser — that the upload route composes. No dispatcher, no telephony, no background work: every endpoint is a synchronous read or state change.

**Tech Stack:** Express 4, TypeScript, Prisma, Zod, `libphonenumber-js` (`/max` entry point), `csv-parse`, `multer`. Vitest + Supertest for tests.

**Test safety (read first):** Tests run only against `TEST_DATABASE_URL`, which `test/setup.ts` already asserts is set and is not a Neon host. Never point tests at `DATABASE_URL`. Migrations reach the test DB through `npm run test:prepare`, never through `prisma migrate reset`.

**Scoping rule, applies to every task:** no query looks a campaign up by id alone. Always `where: { id, workspaceId }`. Nested rows narrow the same way: `where: { id, campaignId }`.

---

### Task 1: Prisma schema & migration

**Files:**
- Modify: `prisma/schema.prisma`

**Step 1: Add the enums and models**

Append to `prisma/schema.prisma`:

```prisma
enum CampaignStatus {
  DRAFT
  SCHEDULED
  RUNNING
  PAUSED
  COMPLETED
  STOPPED
}

enum CampaignContactStatus {
  PENDING
  QUEUED
  CALLING
  COMPLETED
  FAILED
  EXCLUDED
}

model Campaign {
  id          String         @id @default(cuid())
  workspaceId String
  name        String
  /// No relation yet: the Agent model lands on another branch. See the
  /// campaigns design doc, "Stitch points".
  agentId     String?
  status      CampaignStatus @default(DRAFT)

  // Dialing window, in the campaign's own timezone.
  fromTime String? // "HH:MM"
  toTime   String? // "HH:MM"
  timezone String? // IANA, e.g. "Asia/Kolkata"

  /// ISO-3166 alpha-2. Interprets uploaded numbers that carry no country code
  /// of their own; null means such rows are rejected instead of guessed at.
  defaultCountry String?

  maxAttempts    Int @default(3)
  retryDelayMins Int @default(30)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  workspace Workspace         @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  contacts  CampaignContact[]

  @@index([workspaceId])
  @@index([agentId])
}

model Contact {
  id          String @id @default(cuid())
  workspaceId String
  phone       String // E.164
  name        String?
  /// Every CSV column that is not phone/name, verbatim. A later slice feeds
  /// these to the agent as per-call variables.
  metadata    Json   @default("{}")

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  workspace        Workspace         @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  campaignContacts CampaignContact[]

  // Per workspace, NOT global: two workspaces may each hold the same phone.
  @@unique([workspaceId, phone])
  @@index([workspaceId])
}

model CampaignContact {
  id            String                @id @default(cuid())
  campaignId    String
  contactId     String
  status        CampaignContactStatus @default(PENDING)
  attempts      Int                   @default(0)
  lastAttemptAt DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  campaign Campaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  contact  Contact  @relation(fields: [contactId], references: [id])

  @@unique([campaignId, contactId])
  @@index([contactId])
  @@index([campaignId, status])
}
```

**Step 2: Add the two back-relations to `Workspace`**

Prisma requires both sides. Inside `model Workspace`, next to `members` and `invites`:

```prisma
  campaigns Campaign[]
  contacts  Contact[]
```

These emit no SQL and modify no existing column.

**Step 3: Create the migration**

Run: `npx prisma migrate dev --name campaigns_core`

Expected: a new folder under `prisma/migrations/` containing only `CREATE TYPE` / `CREATE TABLE` / `CREATE INDEX` / `ALTER TABLE ... ADD CONSTRAINT` statements. **Read the generated SQL before continuing.** If it contains any `DROP`, stop and report — that means the schema has drifted.

`DATABASE_URL` is the local dev Postgres. Never run `migrate reset`.

**Step 4: Apply to the test database and regenerate the client**

Run: `npm run test:prepare && npx prisma generate`
Expected: "migrations applied" then a generated client.

**Step 5: Extend the test truncation list**

In `test/setup.ts`, change `TABLES` to truncate children first:

```ts
const TABLES = [
  'CampaignContact',
  'Campaign',
  'Contact',
  'WorkspaceInvite',
  'WorkspaceMember',
  'Workspace',
  'Account',
] as const;
```

**Step 6: Verify the existing suite still passes**

Run: `npm test`
Expected: 39 passed.

**Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations test/setup.ts
git commit -m "feat: add campaign, contact and campaign-contact schema"
```

---

### Task 2: Phone canonicalization

**Files:**
- Create: `src/lib/phone.ts`
- Test: `test/phone.test.ts`

**Step 1: Install the parser**

Run: `npm install libphonenumber-js`

**Step 2: Write the failing test**

`test/phone.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canonicalizeE164 } from '../src/lib/phone.js';

describe('canonicalizeE164', () => {
  it('keeps a number that carries its own country code', () => {
    expect(canonicalizeE164('+919876543210')).toBe('+919876543210');
    expect(canonicalizeE164('+1 (415) 555-0132')).toBe('+14155550132');
  });

  it('accepts the 00 international prefix', () => {
    expect(canonicalizeE164('00919876543210')).toBe('+919876543210');
  });

  it('accepts digits that already contain a country code but lost the plus', () => {
    expect(canonicalizeE164('919876543210')).toBe('+919876543210');
  });

  it('rejects an E.164-shaped number that is not a real one', () => {
    // +91 followed by an 8-digit stub. A regex check accepts this; it is not
    // a phone number and fails at dial time.
    expect(canonicalizeE164('9109518550')).toBeNull();
    expect(canonicalizeE164('+9109518550')).toBeNull();
  });

  it('rejects a bare national number when no country is supplied', () => {
    expect(canonicalizeE164('9876543210')).toBeNull();
  });

  it('interprets a bare national number against an explicit country', () => {
    expect(canonicalizeE164('9876543210', 'IN')).toBe('+919876543210');
  });

  it('never lets a default country override an explicit one', () => {
    expect(canonicalizeE164('+14155550132', 'IN')).toBe('+14155550132');
  });

  it('rejects junk rather than stripping it', () => {
    expect(canonicalizeE164('')).toBeNull();
    expect(canonicalizeE164('   ')).toBeNull();
    expect(canonicalizeE164('call me maybe')).toBeNull();
    expect(canonicalizeE164('+91 98765 43210 ext 12')).toBeNull();
  });

  it('rejects an unusable country code', () => {
    expect(isCountryCode('IN')).toBe(true);
    expect(isCountryCode('XX')).toBe(false);
    expect(isCountryCode('india')).toBe(false);
  });
});
```

Add `isCountryCode` to the import.

**Step 3: Run it and watch it fail**

Run: `npx vitest run test/phone.test.ts`
Expected: FAIL — cannot resolve `../src/lib/phone.js`.

**Step 4: Implement**

`src/lib/phone.ts`:

```ts
/**
 * The single phone-number canonicalizer. Every number entering the system
 * passes through here before it is stored.
 *
 * `/max`, deliberately — NOT the default entry point. The default ships `min`
 * metadata, whose isValid() degrades to little more than a length check in
 * several countries: with it every 10-digit string is "valid" in India,
 * '5555555555' included. `max` carries the full per-type patterns. The extra
 * metadata is irrelevant server-side and is the only reason to use a parser
 * here rather than a regular expression.
 */
import { parsePhoneNumberFromString, isSupportedCountry, type CountryCode } from 'libphonenumber-js/max';

export type { CountryCode };

/**
 * A leading '+' is optional and may only appear at position 0. Letters,
 * extensions and interior '+' are rejected outright rather than stripped —
 * silently deleting characters is how a vanity number becomes a different
 * dial target.
 */
const HARMLESS_FORMAT = /^\+?[\d\s().-]+$/;

export function isCountryCode(value: string): value is CountryCode {
  return isSupportedCountry(value);
}

/**
 * Canonicalize a phone number to E.164, or null.
 *
 * `defaultCountry` is consulted ONLY for input carrying no country of its own,
 * so it can never override an explicit country code. The result is gated on
 * isValid() rather than isPossible(), so '+9109518550' — country code +91 plus
 * an 8-digit stub — is rejected instead of returned as a plausible-looking
 * destination.
 */
export function canonicalizeE164(raw: string, defaultCountry?: CountryCode): string | null {
  const trimmed = raw.trim();
  if (!trimmed || !HARMLESS_FORMAT.test(trimmed)) return null;

  const compact = trimmed.replace(/[\s().-]/g, '');
  if (!compact) return null;

  // '00' is the international call prefix; the remainder is E.164.
  const input = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;

  const parsed = parsePhoneNumberFromString(input, defaultCountry);
  if (parsed?.isValid()) return parsed.number;

  // Digit-only input that is really E.164 minus its '+'. Providers and
  // spreadsheet exports drop it constantly. This does not reintroduce country
  // invention: the result must still be parser-valid, so '9109518550' ->
  // '+9109518550' stays rejected.
  if (!input.startsWith('+')) {
    const asE164 = parsePhoneNumberFromString(`+${input}`);
    if (asE164?.isValid()) return asE164.number;
  }

  return null;
}
```

**Step 5: Run the test**

Run: `npx vitest run test/phone.test.ts`
Expected: PASS.

**Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/phone.ts test/phone.test.ts
git commit -m "feat: add E.164 phone canonicalization"
```

---

### Task 3: CSV contact parsing

**Files:**
- Create: `src/lib/contacts-csv.ts`
- Test: `test/contacts-csv.test.ts`

**Step 1: Install the parser**

Run: `npm install csv-parse`

**Step 2: Write the failing test**

`test/contacts-csv.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CsvError, parseContactsCsv } from '../src/lib/contacts-csv.js';

const csv = (s: string) => Buffer.from(s, 'utf8');

describe('parseContactsCsv', () => {
  it('reads phone, name, and every other column as metadata', () => {
    const result = parseContactsCsv(
      csv('phone,name,city,plan\n+919876543210,Asha,Pune,Gold\n'),
    );

    expect(result.invalid).toEqual([]);
    expect(result.rows).toEqual([
      {
        row: 2,
        phone: '+919876543210',
        name: 'Asha',
        metadata: { city: 'Pune', plan: 'Gold' },
      },
    ]);
  });

  it('treats the phone column name case-insensitively', () => {
    const result = parseContactsCsv(csv('Phone\n+919876543210\n'));
    expect(result.rows).toHaveLength(1);
  });

  it('requires a phone column', () => {
    expect(() => parseContactsCsv(csv('name,city\nAsha,Pune\n'))).toThrow(CsvError);
  });

  it('requires a header row it can use', () => {
    expect(() => parseContactsCsv(csv(''))).toThrow(CsvError);
  });

  it('reports a bad row by its spreadsheet row number and keeps the good ones', () => {
    const result = parseContactsCsv(
      csv('phone,name\n+919876543210,Asha\nnot-a-number,Bad\n,Blank\n+14155550132,Ravi\n'),
    );

    expect(result.rows.map((r) => r.phone)).toEqual(['+919876543210', '+14155550132']);
    expect(result.invalid).toEqual([
      { row: 3, phone: 'not-a-number', reason: 'Not a valid phone number.' },
      { row: 4, phone: '', reason: 'Phone number is required.' },
    ]);
  });

  it('rejects a bare national number without a default country', () => {
    const result = parseContactsCsv(csv('phone\n9876543210\n'));
    expect(result.rows).toEqual([]);
    expect(result.invalid[0]!.reason).toContain('country code');
  });

  it('accepts a bare national number against the campaign default country', () => {
    const result = parseContactsCsv(csv('phone\n9876543210\n'), 'IN');
    expect(result.rows[0]!.phone).toBe('+919876543210');
  });

  it('leaves a name blank rather than storing an empty string', () => {
    const result = parseContactsCsv(csv('phone,name\n+919876543210,\n'));
    expect(result.rows[0]!.name).toBeUndefined();
  });
});
```

**Step 3: Run it and watch it fail**

Run: `npx vitest run test/contacts-csv.test.ts`
Expected: FAIL — module not found.

**Step 4: Implement**

`src/lib/contacts-csv.ts`:

```ts
import { parse } from 'csv-parse/sync';
import { canonicalizeE164, type CountryCode } from './phone.js';

export interface ParsedContactRow {
  row: number;
  phone: string;
  name?: string;
  metadata: Record<string, string>;
}

export interface InvalidContactRow {
  row: number;
  phone: string;
  reason: string;
}

export interface ParsedContactsCsv {
  rows: ParsedContactRow[];
  invalid: InvalidContactRow[];
}

/** A problem with the file as a whole — no row could succeed. */
export class CsvError extends Error {
  constructor(
    readonly code: 'CSV_PARSE_ERROR' | 'CSV_PHONE_COLUMN_MISSING',
    message: string,
  ) {
    super(message);
    this.name = 'CsvError';
  }
}

const PHONE_HEADER = 'phone';
const NAME_HEADER = 'name';

/**
 * Parses an uploaded CSV into contact rows.
 *
 * A row-level problem never fails the file: an unusable phone is reported in
 * `invalid` with the row number a spreadsheet would show (header is row 1) and
 * the remaining rows still load.
 */
export function parseContactsCsv(
  buffer: Buffer,
  defaultCountry?: CountryCode,
): ParsedContactsCsv {
  let records: Record<string, string>[];

  try {
    records = parse(buffer, {
      bom: true,
      columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }) as Record<string, string>[];
  } catch (error) {
    throw new CsvError(
      'CSV_PARSE_ERROR',
      error instanceof Error ? error.message : 'That file could not be read as CSV.',
    );
  }

  // `columns` consumed the first line as headers, so an empty file yields no
  // records AND no headers — indistinguishable here from a header-only file,
  // which is equally unusable.
  const headers = Object.keys(records[0] ?? {});
  if (records.length === 0 || !headers.includes(PHONE_HEADER)) {
    throw new CsvError(
      'CSV_PHONE_COLUMN_MISSING',
      'The CSV needs a header row with a "phone" column.',
    );
  }

  const rows: ParsedContactRow[] = [];
  const invalid: InvalidContactRow[] = [];

  records.forEach((record, index) => {
    const row = index + 2; // header is row 1
    const raw = (record[PHONE_HEADER] ?? '').trim();

    if (!raw) {
      invalid.push({ row, phone: '', reason: 'Phone number is required.' });
      return;
    }

    const phone = canonicalizeE164(raw, defaultCountry);
    if (!phone) {
      invalid.push({
        row,
        phone: raw,
        reason: defaultCountry
          ? 'Not a valid phone number.'
          : 'Not a valid phone number. Include the country code, e.g. +919876543210.',
      });
      return;
    }

    const metadata: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === PHONE_HEADER || key === NAME_HEADER || !key) continue;
      if (value) metadata[key] = value;
    }

    const name = (record[NAME_HEADER] ?? '').trim();
    rows.push({ row, phone, ...(name ? { name } : {}), metadata });
  });

  return { rows, invalid };
}
```

Note the two `reason` strings the tests assert against: the no-default-country case must mention "country code".

**Step 5: Run the test**

Run: `npx vitest run test/contacts-csv.test.ts`
Expected: PASS.

**Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/contacts-csv.ts test/contacts-csv.test.ts
git commit -m "feat: add CSV contact parsing with per-row error reporting"
```

---

### Task 4: Campaign CRUD with workspace isolation

**Files:**
- Create: `src/routes/campaigns.routes.ts`, `src/lib/campaign.ts`
- Modify: `src/app.ts`, `src/lib/errors.ts`
- Test: `test/campaigns.test.ts`

**Step 1: Write the failing tests**

`test/campaigns.test.ts` — isolation and role gating first, because they are the requirement:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makeWorkspace } from './helpers.js';

const app = createApp();

beforeEach(async () => {
  await truncateAll();
});

describe('campaign isolation', () => {
  it('404s a campaign that belongs to another workspace', async () => {
    const alice = await makeAccount('alice');
    const a = await makeWorkspace(alice, 'A Co');
    const b = await makeWorkspace(alice, 'B Co');
    const inB = await prisma.campaign.create({ data: { workspaceId: b.id, name: 'B campaign' } });

    // Alice is a member of BOTH, so this is not a permission failure — the
    // campaign simply does not exist in workspace A.
    const res = await request(app)
      .get(`/api/workspaces/${a.id}/campaigns/${inB.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('403s a workspace the caller is not a member of', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const b = await makeWorkspace(bob, 'B Co');

    const res = await request(app)
      .get(`/api/workspaces/${b.id}/campaigns`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(403);
  });

  it('never lists another workspace campaign', async () => {
    const alice = await makeAccount('alice');
    const a = await makeWorkspace(alice, 'A Co');
    const b = await makeWorkspace(alice, 'B Co');
    await prisma.campaign.create({ data: { workspaceId: a.id, name: 'Mine' } });
    await prisma.campaign.create({ data: { workspaceId: b.id, name: 'Theirs' } });

    const res = await request(app)
      .get(`/api/workspaces/${a.id}/campaigns`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data.campaigns).toHaveLength(1);
    expect(res.body.data.campaigns[0].name).toBe('Mine');
  });

  it('404s a PATCH and a DELETE across the boundary', async () => {
    const alice = await makeAccount('alice');
    const a = await makeWorkspace(alice, 'A Co');
    const b = await makeWorkspace(alice, 'B Co');
    const inB = await prisma.campaign.create({ data: { workspaceId: b.id, name: 'B campaign' } });

    const patch = await request(app)
      .patch(`/api/workspaces/${a.id}/campaigns/${inB.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ name: 'hijacked' });
    expect(patch.status).toBe(404);

    const del = await request(app)
      .delete(`/api/workspaces/${a.id}/campaigns/${inB.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));
    expect(del.status).toBe(404);

    // And the row is untouched.
    const still = await prisma.campaign.findUniqueOrThrow({ where: { id: inB.id } });
    expect(still.name).toBe('B campaign');
  });
});

describe('campaign role gating', () => {
  it('lets a MEMBER read but not create', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const ws = await makeWorkspace(alice, 'A Co');
    await addMember(ws, bob, 'MEMBER');
    await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'Q3 outreach' } });

    const read = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns`)
      .set(...as('user_bob', 'bob@ezo.test'));
    expect(read.status).toBe(200);
    expect(read.body.data.campaigns).toHaveLength(1);

    const write = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns`)
      .set(...as('user_bob', 'bob@ezo.test'))
      .send({ name: 'Nope' });
    expect(write.status).toBe(403);
  });
});

describe('POST /api/workspaces/:id/campaigns', () => {
  it('creates a DRAFT campaign', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ name: 'Q3 outreach' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Q3 outreach',
      status: 'DRAFT',
      agentId: null,
      contactCount: 0,
    });
  });

  it('rejects a blank name', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ name: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/workspaces/:id/campaigns', () => {
  it('filters by status and reports contact counts', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const draft = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'Draft one' } });
    await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Running one', status: 'RUNNING', agentId: 'agt_1' },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919876543210' },
    });
    await prisma.campaignContact.create({
      data: { campaignId: draft.id, contactId: contact.id },
    });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns?status=DRAFT`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data.campaigns).toHaveLength(1);
    expect(res.body.data.campaigns[0]).toMatchObject({ name: 'Draft one', contactCount: 1 });
  });

  it('rejects an unknown status filter', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns?status=BANANA`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/workspaces/:id/campaigns/:cid', () => {
  it('updates name, agent and dialing config', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const c = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'Old' } });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${c.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({
        name: 'New',
        agentId: 'agt_123',
        fromTime: '09:00',
        toTime: '18:00',
        timezone: 'Asia/Kolkata',
        defaultCountry: 'IN',
        maxAttempts: 5,
        retryDelayMins: 45,
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'New',
      agentId: 'agt_123',
      fromTime: '09:00',
      timezone: 'Asia/Kolkata',
      defaultCountry: 'IN',
      maxAttempts: 5,
    });
  });

  it('rejects a malformed dialing window, timezone or country', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const c = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'C' } });
    const url = `/api/workspaces/${ws.id}/campaigns/${c.id}`;
    const auth = as('user_alice', 'alice@ezo.test');

    for (const body of [
      { fromTime: '9am' },
      { fromTime: '25:00' },
      { timezone: 'Mars/Olympus' },
      { defaultCountry: 'XX' },
      { maxAttempts: 0 },
      { retryDelayMins: -1 },
    ]) {
      const res = await request(app).patch(url).set(...auth).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('clears the agent when sent null', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const c = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'C', agentId: 'agt_1' },
    });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${c.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ agentId: null });

    expect(res.body.data.agentId).toBeNull();
  });
});

describe('DELETE /api/workspaces/:id/campaigns/:cid', () => {
  it('deletes a DRAFT campaign and its membership rows', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const c = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'C' } });
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919876543210' },
    });
    await prisma.campaignContact.create({ data: { campaignId: c.id, contactId: contact.id } });

    const res = await request(app)
      .delete(`/api/workspaces/${ws.id}/campaigns/${c.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(await prisma.campaignContact.count()).toBe(0);
    // The contact itself survives — it belongs to the workspace, not the campaign.
    expect(await prisma.contact.count()).toBe(1);
  });

  it('refuses to delete a RUNNING or PAUSED campaign', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');

    for (const status of ['RUNNING', 'PAUSED'] as const) {
      const c = await prisma.campaign.create({
        data: { workspaceId: ws.id, name: status, status },
      });
      const res = await request(app)
        .delete(`/api/workspaces/${ws.id}/campaigns/${c.id}`)
        .set(...as('user_alice', 'alice@ezo.test'));

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CAMPAIGN_NOT_DELETABLE');
    }
  });
});
```

**Step 2: Run and watch it fail**

Run: `npx vitest run test/campaigns.test.ts`
Expected: FAIL — every request 404s because the routes are not mounted.

**Step 3: Add the new error codes**

In `src/lib/errors.ts`, extend `ErrorCode`:

```ts
  | 'INVALID_CAMPAIGN_TRANSITION'
  | 'CAMPAIGN_NOT_DELETABLE'
  | 'CAMPAIGN_AGENT_REQUIRED'
  | 'CAMPAIGN_REQUIRES_PENDING_CONTACTS'
  | 'CAMPAIGN_CONTACTS_LOCKED'
  | 'CSV_FILE_REQUIRED'
  | 'CSV_PARSE_ERROR'
  | 'CSV_PHONE_COLUMN_MISSING'
```

**Step 4: Write the scoped lookup and serializer**

`src/lib/campaign.ts`:

```ts
import type { Campaign } from '@prisma/client';
import { prisma } from './prisma.js';
import { ApiError } from './errors.js';

/**
 * Looks a campaign up inside one workspace only.
 *
 * This is the isolation boundary: an id from another workspace finds nothing
 * and 404s, so no caller can reach across by passing a foreign id. Never
 * replace this with a lookup by id alone plus a separate ownership check —
 * that is the version somebody forgets to write.
 */
export async function campaignInWorkspace(
  workspaceId: string,
  campaignId: string,
): Promise<Campaign> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, workspaceId },
  });

  if (!campaign) {
    throw new ApiError(404, 'NOT_FOUND', 'Campaign not found.');
  }

  return campaign;
}

export function serializeCampaign(campaign: Campaign, contactCount?: number) {
  return {
    id: campaign.id,
    name: campaign.name,
    agentId: campaign.agentId,
    status: campaign.status,
    fromTime: campaign.fromTime,
    toTime: campaign.toTime,
    timezone: campaign.timezone,
    defaultCountry: campaign.defaultCountry,
    maxAttempts: campaign.maxAttempts,
    retryDelayMins: campaign.retryDelayMins,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    ...(contactCount === undefined ? {} : { contactCount }),
  };
}
```

**Step 5: Write the routes**

`src/routes/campaigns.routes.ts` — the CRUD half:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireMembership, workspaceOf } from '../middleware/workspace.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { parseBody } from '../lib/validate.js';
import { campaignInWorkspace, serializeCampaign } from '../lib/campaign.js';
import { isCountryCode } from '../lib/phone.js';

export const campaignRoutes: Router = Router();

const CAMPAIGN_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'STOPPED',
] as const;

/** Statuses a campaign may be deleted from — everything else is live work. */
const DELETABLE = ['DRAFT', 'STOPPED', 'COMPLETED'] as const;

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM, e.g. 09:00.');

const timezone = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Use an IANA timezone, e.g. Asia/Kolkata.' },
);

const createSchema = z.object({ name: z.string().trim().min(1).max(120) });

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    agentId: z.string().trim().min(1).max(191).nullable(),
    fromTime: timeOfDay.nullable(),
    toTime: timeOfDay.nullable(),
    timezone: timezone.nullable(),
    defaultCountry: z
      .string()
      .toUpperCase()
      .refine(isCountryCode, { message: 'Use an ISO-3166 alpha-2 country code, e.g. IN.' })
      .nullable(),
    maxAttempts: z.number().int().min(1).max(20),
    retryDelayMins: z.number().int().min(0).max(10080),
  })
  .partial();

const listQuerySchema = z.object({
  status: z.enum(CAMPAIGN_STATUSES).optional(),
});

campaignRoutes.get(
  '/:workspaceId/campaigns',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const { status } = parseBody(listQuerySchema, req.query);

    const campaigns = await prisma.campaign.findMany({
      where: { workspaceId: workspaceOf(req).id, ...(status ? { status } : {}) },
      include: { _count: { select: { contacts: true } } },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: {
        campaigns: campaigns.map((c) => serializeCampaign(c, c._count.contacts)),
      },
    });
  }),
);

campaignRoutes.post(
  '/:workspaceId/campaigns',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const { name } = parseBody(createSchema, req.body);

    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspaceOf(req).id, name },
    });

    res.status(201).json({ success: true, data: serializeCampaign(campaign, 0) });
  }),
);

campaignRoutes.get(
  '/:workspaceId/campaigns/:campaignId',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);
    const contactCount = await prisma.campaignContact.count({
      where: { campaignId: campaign.id },
    });

    res.json({ success: true, data: serializeCampaign(campaign, contactCount) });
  }),
);

campaignRoutes.patch(
  '/:workspaceId/campaigns/:campaignId',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);
    const data = parseBody(updateSchema, req.body);

    const updated = await prisma.campaign.update({ where: { id: campaign.id }, data });
    const contactCount = await prisma.campaignContact.count({
      where: { campaignId: campaign.id },
    });

    res.json({ success: true, data: serializeCampaign(updated, contactCount) });
  }),
);

campaignRoutes.delete(
  '/:workspaceId/campaigns/:campaignId',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);

    if (!DELETABLE.includes(campaign.status as (typeof DELETABLE)[number])) {
      throw new ApiError(
        409,
        'CAMPAIGN_NOT_DELETABLE',
        'Stop the campaign before deleting it.',
      );
    }

    // CampaignContact rows cascade; the Contact rows are the workspace's and stay.
    await prisma.campaign.delete({ where: { id: campaign.id } });

    res.json({ success: true, data: { id: campaign.id, deleted: true } });
  }),
);
```

Note `parseBody` is reused for the query string — it validates any object and returns the same `VALIDATION_ERROR` envelope.

**Step 6: Mount the router**

In `src/app.ts`, import `campaignRoutes` and add alongside the other workspace routers:

```ts
  app.use('/api/workspaces', campaignRoutes);
```

**Step 7: Run the tests**

Run: `npx vitest run test/campaigns.test.ts`
Expected: PASS.

**Step 8: Commit**

```bash
git add src/routes/campaigns.routes.ts src/lib/campaign.ts src/lib/errors.ts src/app.ts test/campaigns.test.ts
git commit -m "feat: add workspace-scoped campaign CRUD"
```

---

### Task 5: CSV contact upload

**Files:**
- Modify: `src/routes/campaigns.routes.ts`
- Test: `test/campaign-contacts.test.ts`

**Step 1: Install multer**

Run: `npm install multer && npm install -D @types/multer`

**Step 2: Confirm how Express parses the `:upload` path segment**

`/contacts:upload` is ambiguous to the router: `:upload` looks like a route parameter. Before writing the route, verify what actually matches by adding a temporary route and hitting it, or just define the path with the colon escaped:

```ts
'/:workspaceId/campaigns/:campaignId/contacts\\:upload'
```

Then assert it in the test below by requesting the literal URL. If the escaped form does not match, fall back to a RegExp path. Do not guess — the test is the check.

**Step 3: Write the failing tests**

`test/campaign-contacts.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makeWorkspace } from './helpers.js';

const app = createApp();

beforeEach(async () => {
  await truncateAll();
});

async function setup(status: 'DRAFT' | 'RUNNING' = 'DRAFT') {
  const alice = await makeAccount('alice');
  const ws = await makeWorkspace(alice, 'A Co');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: ws.id, name: 'Q3', status },
  });
  return { alice, ws, campaign };
}

const upload = (ws: string, campaign: string) =>
  `/api/workspaces/${ws}/campaigns/${campaign}/contacts:upload`;

const post = (url: string, csv: string, user = 'user_alice', email = 'alice@ezo.test') =>
  request(app)
    .post(url)
    .set(...as(user, email))
    .attach('file', Buffer.from(csv, 'utf8'), 'contacts.csv');

describe('POST .../contacts:upload', () => {
  it('loads contacts, mapping extra columns to metadata', async () => {
    const { ws, campaign } = await setup();

    const res = await post(
      upload(ws.id, campaign.id),
      'phone,name,city\n+919876543210,Asha,Pune\n+14155550132,Ravi,SF\n',
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ added: 2, duplicates: 0, invalid: [] });

    const contacts = await prisma.contact.findMany({ orderBy: { phone: 'asc' } });
    expect(contacts.map((c) => c.phone)).toEqual(['+14155550132', '+919876543210']);
    expect(contacts[1]!.metadata).toEqual({ city: 'Pune' });

    const links = await prisma.campaignContact.findMany();
    expect(links).toHaveLength(2);
    expect(links.every((l) => l.status === 'PENDING')).toBe(true);
  });

  it('reports malformed rows by row number without failing the file', async () => {
    const { ws, campaign } = await setup();

    const res = await post(
      upload(ws.id, campaign.id),
      'phone,name\n+919876543210,Asha\nnope,Bad\n,Blank\n',
    );

    expect(res.body.data.added).toBe(1);
    expect(res.body.data.invalid).toEqual([
      { row: 3, phone: 'nope', reason: expect.stringContaining('country code') },
      { row: 4, phone: '', reason: 'Phone number is required.' },
    ]);
  });

  it('counts a repeated phone as a duplicate, within a file and across uploads', async () => {
    const { ws, campaign } = await setup();
    const url = upload(ws.id, campaign.id);

    const first = await post(url, 'phone\n+919876543210\n+919876543210\n');
    expect(first.body.data).toMatchObject({ added: 1, duplicates: 1 });

    const second = await post(url, 'phone\n+919876543210\n+14155550132\n');
    expect(second.body.data).toMatchObject({ added: 1, duplicates: 1 });

    expect(await prisma.campaignContact.count()).toBe(2);
  });

  it('refreshes name and metadata when a known phone is re-uploaded', async () => {
    const { ws, campaign } = await setup();
    const url = upload(ws.id, campaign.id);

    await post(url, 'phone,name,city\n+919876543210,Asha,Pune\n');
    await post(url, 'phone,name,city\n+919876543210,Asha Rao,Mumbai\n');

    const contact = await prisma.contact.findFirstOrThrow();
    expect(contact.name).toBe('Asha Rao');
    expect(contact.metadata).toEqual({ city: 'Mumbai' });
  });

  it('keeps the same phone separate in two workspaces', async () => {
    const alice = await makeAccount('alice');
    const a = await makeWorkspace(alice, 'A Co');
    const b = await makeWorkspace(alice, 'B Co');
    const ca = await prisma.campaign.create({ data: { workspaceId: a.id, name: 'A' } });
    const cb = await prisma.campaign.create({ data: { workspaceId: b.id, name: 'B' } });

    const first = await post(upload(a.id, ca.id), 'phone,name\n+919876543210,Asha\n');
    const second = await post(upload(b.id, cb.id), 'phone,name\n+919876543210,Asha\n');

    // Neither upload sees the other's contact as a duplicate.
    expect(first.body.data).toMatchObject({ added: 1, duplicates: 0 });
    expect(second.body.data).toMatchObject({ added: 1, duplicates: 0 });
    expect(await prisma.contact.count()).toBe(2);
  });

  it('uses the campaign default country for bare national numbers', async () => {
    const { ws, campaign } = await setup();

    const withoutDefault = await post(upload(ws.id, campaign.id), 'phone\n9876543210\n');
    expect(withoutDefault.body.data.added).toBe(0);

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { defaultCountry: 'IN' },
    });

    const withDefault = await post(upload(ws.id, campaign.id), 'phone\n9876543210\n');
    expect(withDefault.body.data.added).toBe(1);
    expect((await prisma.contact.findFirstOrThrow()).phone).toBe('+919876543210');
  });

  it('rejects a file with no phone column', async () => {
    const { ws, campaign } = await setup();

    const res = await post(upload(ws.id, campaign.id), 'name,city\nAsha,Pune\n');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CSV_PHONE_COLUMN_MISSING');
  });

  it('requires a file', async () => {
    const { ws, campaign } = await setup();

    const res = await request(app)
      .post(upload(ws.id, campaign.id))
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CSV_FILE_REQUIRED');
  });

  it('refuses to upload into a RUNNING campaign', async () => {
    const { ws, campaign } = await setup('RUNNING');

    const res = await post(upload(ws.id, campaign.id), 'phone\n+919876543210\n');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_CONTACTS_LOCKED');
  });

  it('404s an upload aimed at another workspace campaign', async () => {
    const alice = await makeAccount('alice');
    const a = await makeWorkspace(alice, 'A Co');
    const b = await makeWorkspace(alice, 'B Co');
    const inB = await prisma.campaign.create({ data: { workspaceId: b.id, name: 'B' } });

    const res = await post(upload(a.id, inB.id), 'phone\n+919876543210\n');

    expect(res.status).toBe(404);
    expect(await prisma.contact.count()).toBe(0);
  });

  it('refuses a MEMBER', async () => {
    const { ws, campaign } = await setup();
    const bob = await makeAccount('bob');
    await addMember(ws, bob, 'MEMBER');

    const res = await post(
      upload(ws.id, campaign.id),
      'phone\n+919876543210\n',
      'user_bob',
      'bob@ezo.test',
    );

    expect(res.status).toBe(403);
  });
});
```

**Step 4: Run and watch it fail**

Run: `npx vitest run test/campaign-contacts.test.ts`
Expected: FAIL — 404 on the upload path.

**Step 5: Implement the route**

Add to `src/routes/campaigns.routes.ts`:

```ts
import multer from 'multer';
import { CsvError, parseContactsCsv } from '../lib/contacts-csv.js';
import type { CountryCode } from '../lib/phone.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

/** Uploads are accepted only while nothing is dialing from the list. */
const UPLOADABLE = ['DRAFT', 'PAUSED'] as const;

campaignRoutes.post(
  '/:workspaceId/campaigns/:campaignId/contacts\\:upload',
  requireAuth,
  requireMembership('ADMIN'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);

    if (!UPLOADABLE.includes(campaign.status as (typeof UPLOADABLE)[number])) {
      throw new ApiError(
        409,
        'CAMPAIGN_CONTACTS_LOCKED',
        'Pause the campaign before changing its contacts.',
      );
    }

    if (!req.file) {
      throw new ApiError(400, 'CSV_FILE_REQUIRED', 'Attach a CSV file in the "file" field.');
    }

    let parsed;
    try {
      parsed = parseContactsCsv(
        req.file.buffer,
        (campaign.defaultCountry ?? undefined) as CountryCode | undefined,
      );
    } catch (error) {
      if (error instanceof CsvError) throw new ApiError(400, error.code, error.message);
      throw error;
    }

    let added = 0;
    let duplicates = 0;

    for (const row of parsed.rows) {
      // Upsert on the per-workspace key, so a phone known to another workspace
      // is a different contact entirely.
      const contact = await prisma.contact.upsert({
        where: { workspaceId_phone: { workspaceId: campaign.workspaceId, phone: row.phone } },
        create: {
          workspaceId: campaign.workspaceId,
          phone: row.phone,
          name: row.name,
          metadata: row.metadata,
        },
        update: {
          ...(row.name ? { name: row.name } : {}),
          metadata: row.metadata,
        },
      });

      // The unique on (campaignId, contactId) is what makes a repeat a
      // duplicate rather than a second row — and therefore a second call.
      const link = await prisma.campaignContact.createMany({
        data: { campaignId: campaign.id, contactId: contact.id },
        skipDuplicates: true,
      });

      if (link.count === 1) added += 1;
      else duplicates += 1;
    }

    res.json({ success: true, data: { added, duplicates, invalid: parsed.invalid } });
  }),
);
```

Note the middleware order: `requireMembership('ADMIN')` runs *before* `multer`, so an unauthorized caller never gets their file buffered into memory.

**Step 6: Run the tests**

Run: `npx vitest run test/campaign-contacts.test.ts`
Expected: PASS. If the `\\:upload` path did not match, switch to a RegExp path and re-run — the test tells you which.

**Step 7: Commit**

```bash
git add package.json package-lock.json src/routes/campaigns.routes.ts test/campaign-contacts.test.ts
git commit -m "feat: add CSV contact upload to campaigns"
```

---

### Task 6: Contact listing, exclusion, and stats

**Files:**
- Modify: `src/routes/campaigns.routes.ts`
- Test: `test/campaign-contacts.test.ts` (append)

**Step 1: Write the failing tests**

Append to `test/campaign-contacts.test.ts`:

```ts
describe('GET .../contacts', () => {
  it('paginates and filters by status', async () => {
    const { ws, campaign } = await setup();
    for (let i = 0; i < 5; i += 1) {
      const contact = await prisma.contact.create({
        data: { workspaceId: ws.id, phone: `+9198765432${10 + i}`, name: `C${i}` },
      });
      await prisma.campaignContact.create({
        data: {
          campaignId: campaign.id,
          contactId: contact.id,
          status: i === 0 ? 'EXCLUDED' : 'PENDING',
        },
      });
    }

    const page = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts?limit=2`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(page.status).toBe(200);
    expect(page.body.data.contacts).toHaveLength(2);
    expect(page.body.data.total).toBe(5);
    expect(page.body.data.contacts[0]).toHaveProperty('phone');

    const next = await request(app)
      .get(
        `/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts?limit=2&cursor=${page.body.data.nextCursor}`,
      )
      .set(...as('user_alice', 'alice@ezo.test'));
    expect(next.body.data.contacts).toHaveLength(2);
    expect(next.body.data.contacts[0].id).not.toBe(page.body.data.contacts[0].id);

    const filtered = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts?status=EXCLUDED`)
      .set(...as('user_alice', 'alice@ezo.test'));
    expect(filtered.body.data.contacts).toHaveLength(1);
    expect(filtered.body.data.total).toBe(1);
  });
});

describe('DELETE .../contacts/:ccid', () => {
  it('excludes rather than deletes', async () => {
    const { ws, campaign } = await setup();
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919876543210' },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });

    const res = await request(app)
      .delete(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts/${link.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('EXCLUDED');
    // The row survives — it is the record that this person was on this list.
    expect(await prisma.campaignContact.count()).toBe(1);
  });

  it('404s a contact row from another campaign', async () => {
    const { ws, campaign } = await setup();
    const other = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'Other' } });
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919876543210' },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: other.id, contactId: contact.id },
    });

    const res = await request(app)
      .delete(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts/${link.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(404);
  });

  it('refuses a MEMBER', async () => {
    const { ws, campaign } = await setup();
    const bob = await makeAccount('bob');
    await addMember(ws, bob, 'MEMBER');
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919876543210' },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });

    const res = await request(app)
      .delete(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts/${link.id}`)
      .set(...as('user_bob', 'bob@ezo.test'));

    expect(res.status).toBe(403);
  });
});

describe('GET .../stats', () => {
  it('counts every status, including the ones at zero', async () => {
    const { ws, campaign } = await setup();
    const statuses = ['PENDING', 'PENDING', 'COMPLETED', 'EXCLUDED'] as const;

    for (const [i, status] of statuses.entries()) {
      const contact = await prisma.contact.create({
        data: { workspaceId: ws.id, phone: `+9198765432${10 + i}` },
      });
      await prisma.campaignContact.create({
        data: { campaignId: campaign.id, contactId: contact.id, status },
      });
    }

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/stats`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      total: 4,
      byStatus: {
        PENDING: 2,
        QUEUED: 0,
        CALLING: 0,
        COMPLETED: 1,
        FAILED: 0,
        EXCLUDED: 1,
      },
    });
  });

  it('is readable by a MEMBER and 404s across workspaces', async () => {
    const { ws, campaign } = await setup();
    const bob = await makeAccount('bob');
    await addMember(ws, bob, 'MEMBER');

    const ok = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/stats`)
      .set(...as('user_bob', 'bob@ezo.test'));
    expect(ok.status).toBe(200);

    const other = await makeWorkspace(bob, 'B Co');
    const crossed = await request(app)
      .get(`/api/workspaces/${other.id}/campaigns/${campaign.id}/stats`)
      .set(...as('user_bob', 'bob@ezo.test'));
    expect(crossed.status).toBe(404);
  });
});
```

**Step 2: Run and watch it fail**

Run: `npx vitest run test/campaign-contacts.test.ts`
Expected: the three new blocks FAIL with 404.

**Step 3: Implement**

Add to `src/routes/campaigns.routes.ts`:

```ts
const CONTACT_STATUSES = [
  'PENDING',
  'QUEUED',
  'CALLING',
  'COMPLETED',
  'FAILED',
  'EXCLUDED',
] as const;

const contactQuerySchema = z.object({
  status: z.enum(CONTACT_STATUSES).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

campaignRoutes.get(
  '/:workspaceId/campaigns/:campaignId/contacts',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);
    const { status, cursor, limit } = parseBody(contactQuerySchema, req.query);

    const where = { campaignId: campaign.id, ...(status ? { status } : {}) };

    const [rows, total] = await Promise.all([
      prisma.campaignContact.findMany({
        where,
        include: { contact: true },
        orderBy: { createdAt: 'asc' },
        take: limit + 1, // one extra row tells us whether another page exists
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
      prisma.campaignContact.count({ where }),
    ]);

    const page = rows.slice(0, limit);

    res.json({
      success: true,
      data: {
        contacts: page.map((row) => ({
          id: row.id,
          status: row.status,
          attempts: row.attempts,
          lastAttemptAt: row.lastAttemptAt,
          createdAt: row.createdAt,
          contactId: row.contactId,
          phone: row.contact.phone,
          name: row.contact.name,
          metadata: row.contact.metadata,
        })),
        total,
        nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
      },
    });
  }),
);

campaignRoutes.delete(
  '/:workspaceId/campaigns/:campaignId/contacts/:campaignContactId',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);

    // Scoped to this campaign, so a row id from another list cannot be reached.
    const link = await prisma.campaignContact.findFirst({
      where: { id: req.params.campaignContactId!, campaignId: campaign.id },
    });

    if (!link) {
      throw new ApiError(404, 'NOT_FOUND', 'Contact not found on this campaign.');
    }

    // EXCLUDED, not deleted: the row records that this person was on this list,
    // and deleting it would let the next upload re-add and dial them.
    const updated = await prisma.campaignContact.update({
      where: { id: link.id },
      data: { status: 'EXCLUDED' },
    });

    res.json({ success: true, data: { id: updated.id, status: updated.status } });
  }),
);

campaignRoutes.get(
  '/:workspaceId/campaigns/:campaignId/stats',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);

    const grouped = await prisma.campaignContact.groupBy({
      by: ['status'],
      where: { campaignId: campaign.id },
      _count: { _all: true },
    });

    // Seed every status at zero so the UI renders a stable set of rows rather
    // than only the statuses that happen to be present.
    const byStatus = Object.fromEntries(CONTACT_STATUSES.map((s) => [s, 0]));
    let total = 0;

    for (const group of grouped) {
      byStatus[group.status] = group._count._all;
      total += group._count._all;
    }

    res.json({ success: true, data: { total, byStatus } });
  }),
);
```

**Step 4: Run the tests**

Run: `npx vitest run test/campaign-contacts.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/routes/campaigns.routes.ts test/campaign-contacts.test.ts
git commit -m "feat: add campaign contact listing, exclusion and stats"
```

---

### Task 7: Lifecycle transitions

**Files:**
- Modify: `src/routes/campaigns.routes.ts`
- Test: `test/campaign-lifecycle.test.ts`

**Step 1: Write the failing tests**

`test/campaign-lifecycle.test.ts` — drive the whole matrix from a table rather than writing 24 near-identical cases:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { CampaignStatus } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makeWorkspace } from './helpers.js';

const app = createApp();

beforeEach(async () => {
  await truncateAll();
});

const ALL: CampaignStatus[] = ['DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'STOPPED'];

/** from-status -> to-status for each action; anything absent must 409. */
const MATRIX: Record<string, Partial<Record<CampaignStatus, CampaignStatus>>> = {
  start: { DRAFT: 'RUNNING', SCHEDULED: 'RUNNING' },
  pause: { RUNNING: 'PAUSED' },
  resume: { PAUSED: 'RUNNING' },
  stop: { DRAFT: 'STOPPED', SCHEDULED: 'STOPPED', RUNNING: 'STOPPED', PAUSED: 'STOPPED' },
};

/** A campaign that satisfies every start guard: an agent and a pending contact. */
async function readyCampaign(status: CampaignStatus) {
  const alice = await makeAccount('alice');
  const ws = await makeWorkspace(alice, 'A Co');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: ws.id, name: 'Q3', status, agentId: 'agt_1' },
  });
  const contact = await prisma.contact.create({
    data: { workspaceId: ws.id, phone: '+919876543210' },
  });
  await prisma.campaignContact.create({
    data: { campaignId: campaign.id, contactId: contact.id },
  });
  return { ws, campaign };
}

const act = (ws: string, campaign: string, action: string) =>
  request(app)
    .post(`/api/workspaces/${ws}/campaigns/${campaign}/${action}`)
    .set(...as('user_alice', 'alice@ezo.test'));

describe('lifecycle transition matrix', () => {
  for (const action of Object.keys(MATRIX)) {
    for (const from of ALL) {
      const to = MATRIX[action]![from];

      it(`${action} from ${from} ${to ? `→ ${to}` : '→ 409'}`, async () => {
        const { ws, campaign } = await readyCampaign(from);
        const res = await act(ws.id, campaign.id, action);

        if (to) {
          expect(res.status).toBe(200);
          expect(res.body.data.status).toBe(to);
          const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
          expect(stored.status).toBe(to);
        } else {
          expect(res.status).toBe(409);
          expect(res.body.error.code).toBe('INVALID_CAMPAIGN_TRANSITION');
          const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
          expect(stored.status).toBe(from); // unchanged
        }
      });
    }
  }
});

describe('start guards', () => {
  it('refuses a campaign with no agent', async () => {
    const { ws, campaign } = await readyCampaign('DRAFT');
    await prisma.campaign.update({ where: { id: campaign.id }, data: { agentId: null } });

    const res = await act(ws.id, campaign.id, 'start');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_AGENT_REQUIRED');
  });

  it('refuses a campaign with no pending contact', async () => {
    const { ws, campaign } = await readyCampaign('DRAFT');
    await prisma.campaignContact.updateMany({
      where: { campaignId: campaign.id },
      data: { status: 'EXCLUDED' },
    });

    const res = await act(ws.id, campaign.id, 'start');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_REQUIRES_PENDING_CONTACTS');
  });
});

describe('resume guards', () => {
  it('resumes a campaign whose contacts are all already in flight', async () => {
    // A campaign paused near its end legitimately has nothing PENDING left.
    // Refusing to resume it would be wrong, so resume does not carry the
    // pending-contact requirement that start does.
    const { ws, campaign } = await readyCampaign('PAUSED');
    await prisma.campaignContact.updateMany({
      where: { campaignId: campaign.id },
      data: { status: 'CALLING' },
    });

    const res = await act(ws.id, campaign.id, 'resume');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('RUNNING');
  });

  it('still requires an agent', async () => {
    const { ws, campaign } = await readyCampaign('PAUSED');
    await prisma.campaign.update({ where: { id: campaign.id }, data: { agentId: null } });

    const res = await act(ws.id, campaign.id, 'resume');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_AGENT_REQUIRED');
  });
});

describe('stop', () => {
  it('leaves contact rows as they were', async () => {
    const { ws, campaign } = await readyCampaign('RUNNING');

    await act(ws.id, campaign.id, 'stop');

    // Never attempted is exactly what these contacts are, and no dispatcher
    // will claim them: it selects on campaign status.
    const link = await prisma.campaignContact.findFirstOrThrow();
    expect(link.status).toBe('PENDING');
  });
});

describe('lifecycle access', () => {
  it('refuses a MEMBER', async () => {
    const { ws, campaign } = await readyCampaign('DRAFT');
    const bob = await makeAccount('bob');
    await addMember(ws, bob, 'MEMBER');

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/start`)
      .set(...as('user_bob', 'bob@ezo.test'));

    expect(res.status).toBe(403);
  });

  it('404s across workspaces', async () => {
    const { campaign } = await readyCampaign('DRAFT');
    const alice = await prisma.account.findFirstOrThrow();
    const other = await makeWorkspace(alice, 'B Co');

    const res = await act(other.id, campaign.id, 'start');
    expect(res.status).toBe(404);
  });
});
```

**Step 2: Run and watch it fail**

Run: `npx vitest run test/campaign-lifecycle.test.ts`
Expected: FAIL — 404 on every action.

**Step 3: Implement**

Add to `src/routes/campaigns.routes.ts`:

```ts
import type { CampaignStatus } from '@prisma/client';

interface Transition {
  from: readonly CampaignStatus[];
  to: CampaignStatus;
  /** Whether the campaign must still have something left to dial. */
  requiresPending: boolean;
  /** Whether an agent must be wired up. */
  requiresAgent: boolean;
}

const TRANSITIONS: Record<string, Transition> = {
  start: { from: ['DRAFT', 'SCHEDULED'], to: 'RUNNING', requiresAgent: true, requiresPending: true },
  pause: { from: ['RUNNING'], to: 'PAUSED', requiresAgent: false, requiresPending: false },
  // resume deliberately drops requiresPending: a campaign paused near its end
  // can have every contact already in flight, and refusing it would be wrong.
  resume: { from: ['PAUSED'], to: 'RUNNING', requiresAgent: true, requiresPending: false },
  stop: {
    from: ['DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED'],
    to: 'STOPPED',
    requiresAgent: false,
    requiresPending: false,
  },
};

for (const [action, transition] of Object.entries(TRANSITIONS)) {
  campaignRoutes.post(
    `/:workspaceId/campaigns/:campaignId/${action}`,
    requireAuth,
    requireMembership('ADMIN'),
    asyncHandler(async (req, res) => {
      const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);

      if (!transition.from.includes(campaign.status)) {
        throw new ApiError(
          409,
          'INVALID_CAMPAIGN_TRANSITION',
          `A ${campaign.status.toLowerCase()} campaign cannot be ${action}ed.`,
        );
      }

      if (transition.requiresAgent && !campaign.agentId) {
        throw new ApiError(
          409,
          'CAMPAIGN_AGENT_REQUIRED',
          'Assign an agent before starting this campaign.',
        );
      }

      if (transition.requiresPending) {
        const pending = await prisma.campaignContact.count({
          where: { campaignId: campaign.id, status: 'PENDING' },
        });

        if (pending === 0) {
          throw new ApiError(
            409,
            'CAMPAIGN_REQUIRES_PENDING_CONTACTS',
            'Add at least one contact before starting this campaign.',
          );
        }
      }

      const updated = await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: transition.to },
      });

      res.json({ success: true, data: serializeCampaign(updated) });
    }),
  );
}
```

The message reads "a draft campaign cannot be started" / "cannot be stopped" — `${action}ed` works for all four verbs here.

**Step 4: Run the tests**

Run: `npx vitest run test/campaign-lifecycle.test.ts`
Expected: PASS — 24 matrix cases plus the guard cases.

**Step 5: Run the whole suite and build**

Run: `npm test && npm run build`
Expected: all files pass; `tsc` exits 0.

**Step 6: Commit**

```bash
git add src/routes/campaigns.routes.ts test/campaign-lifecycle.test.ts
git commit -m "feat: add guarded campaign lifecycle transitions"
```

---

### Task 8: Document the routes

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Add the campaign routes to the route table**

Follow the format already in the file. Include the role each route requires.

**Step 2: Note the open stitch point**

One line recording that `Campaign.agentId` is an unconstrained column awaiting the `Agent` model, so the next person does not mistake it for an oversight.

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document campaign routes"
```
