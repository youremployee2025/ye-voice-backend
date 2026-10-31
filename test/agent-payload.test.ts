import { describe, expect, it } from 'vitest';
import {
  WRITABLE_AGENT_FIELDS,
  createAgentSchema,
  updateAgentSchema,
} from '../src/lib/agentPayload.js';
import { parseBody } from '../src/lib/validate.js';

/**
 * The payload schemas are this service's copy of the platform's field list.
 * They exist so a bad request fails here with a readable message instead of
 * spending an upstream call to be told the same thing — and so a field the
 * platform does not accept can never be forwarded.
 */

const validCreate = {
  agent_name: 'Reception',
  prompt: 'Answer politely.',
  voice_id: 'b7d5c1a2-0000-4000-8000-000000000001',
  agent_type: 'inbound',
};

describe('createAgentSchema', () => {
  it('accepts the four required fields', () => {
    expect(parseBody(createAgentSchema, validCreate)).toMatchObject(validCreate);
  });

  it.each(['agent_name', 'prompt', 'voice_id', 'agent_type'])(
    'rejects a create missing %s',
    (field) => {
      const body: Record<string, unknown> = { ...validCreate };
      delete body[field];

      expect(() => parseBody(createAgentSchema, body)).toThrow(new RegExp(field));
    },
  );

  it('rejects an agent_type the platform does not define', () => {
    expect(() => parseBody(createAgentSchema, { ...validCreate, agent_type: 'sideways' })).toThrow(
      /agent_type/,
    );
  });

  it('rejects a name over the platform limit', () => {
    expect(() => parseBody(createAgentSchema, { ...validCreate, agent_name: 'x'.repeat(51) })).toThrow(
      /agent_name/,
    );
  });

  it('rejects a call duration outside the accepted range', () => {
    expect(() =>
      parseBody(createAgentSchema, { ...validCreate, max_call_duration_secs: 30 }),
    ).toThrow(/max_call_duration_secs/);
    expect(() =>
      parseBody(createAgentSchema, { ...validCreate, max_call_duration_secs: 4000 }),
    ).toThrow(/max_call_duration_secs/);
  });

  it('rejects a background volume outside 0 to 1', () => {
    expect(() =>
      parseBody(createAgentSchema, { ...validCreate, background_audio_volume: 1.4 }),
    ).toThrow(/background_audio_volume/);
  });

  it('rejects more than two spoken languages', () => {
    expect(() =>
      parseBody(createAgentSchema, { ...validCreate, spoken_languages: ['en', 'hi', 'mr'] }),
    ).toThrow(/spoken_languages/);
  });

  it('rejects a language the platform does not support', () => {
    expect(() =>
      parseBody(createAgentSchema, { ...validCreate, spoken_languages: ['fr'] }),
    ).toThrow(/spoken_languages/);
  });

  it('keeps an explicit null on a nullable field, since null means "clear it"', () => {
    const parsed = parseBody(createAgentSchema, { ...validCreate, intro_message: null });

    expect(parsed).toHaveProperty('intro_message', null);
  });
});

describe('updateAgentSchema', () => {
  it('accepts a single field', () => {
    expect(parseBody(updateAgentSchema(), { prompt: 'new' })).toEqual({ prompt: 'new' });
  });

  it('emits only the keys that were supplied', () => {
    const parsed = parseBody(updateAgentSchema(), { prompt: 'new' });

    // A schema that filled in defaults would turn every save into a full
    // overwrite, and two people editing different fields into a lost update.
    expect(Object.keys(parsed)).toEqual(['prompt']);
  });

  it('rejects an update with no fields at all', () => {
    expect(() => parseBody(updateAgentSchema(), {})).toThrow(/at least one/i);
  });

  it('drops fields the platform will not accept rather than forwarding them', () => {
    const parsed = parseBody(updateAgentSchema(), {
      prompt: 'new',
      language: 'en',
      status: 'active',
      document_count: 4,
      id: 'someone-elses-agent',
    });

    expect(parsed).toEqual({ prompt: 'new' });
  });

  it('rejects an update whose only fields are unaccepted ones', () => {
    // Otherwise stripping them leaves an empty body, which the platform
    // rejects with a message that names nothing the caller sent.
    expect(() => parseBody(updateAgentSchema(), { status: 'active' })).toThrow(/at least one/i);
  });
});

/**
 * The two structured fields.
 *
 * Their rules live in `transferDestinations.ts` and `extractionConfig.ts` and
 * are exercised there. What matters here is which schema accepts which, and
 * that a bad one is refused rather than forwarded.
 */
describe('transfer_destinations', () => {
  const destination = {
    key: 'sales_desk',
    label: 'Sales desk',
    number: '+919876543210',
    llmDescription: 'Pricing and new business.',
  };

  it('is accepted on create', () => {
    const parsed = parseBody(createAgentSchema, {
      ...validCreate,
      transfer_destinations: [destination],
    });

    expect(parsed).toHaveProperty('transfer_destinations', [destination]);
  });

  it('is accepted on update', () => {
    expect(
      parseBody(updateAgentSchema(), { transfer_destinations: [destination] }),
    ).toEqual({ transfer_destinations: [destination] });
  });

  /** `null` clears the catalogue; `[]` says it was emptied. Not the same. */
  it('keeps null and an empty array apart', () => {
    expect(parseBody(updateAgentSchema(), { transfer_destinations: null })).toEqual({
      transfer_destinations: null,
    });
    expect(parseBody(updateAgentSchema(), { transfer_destinations: [] })).toEqual({
      transfer_destinations: [],
    });
  });

  it('refuses an invalid entry rather than forwarding it', () => {
    expect(() =>
      parseBody(updateAgentSchema(), {
        transfer_destinations: [{ ...destination, llmDescription: '' }],
      }),
    ).toThrow(/llmDescription/);
  });
});

/**
 * The platform's create route does not read `extraction_config` — it accepts
 * `extraction_enabled` and nothing else about extraction. A create that
 * carried one would report success and store nothing, so it is stripped here
 * rather than sent to be ignored.
 */
describe('extraction_config', () => {
  const config = { prompt: 'Extract the caller intent.', keys: [{ name: 'intent', type: 'string' }] };

  it('is accepted on update', () => {
    const parsed = parseBody(updateAgentSchema(), { extraction_config: config });

    expect(parsed.extraction_config).toMatchObject(config);
  });

  it('is stripped from a create, because the platform would ignore it', () => {
    const parsed = parseBody(createAgentSchema, { ...validCreate, extraction_config: config });

    expect(parsed).not.toHaveProperty('extraction_config');
  });

  it('accepts null on update, which clears it', () => {
    expect(parseBody(updateAgentSchema(), { extraction_config: null })).toEqual({
      extraction_config: null,
    });
  });

  it('refuses an invalid config rather than forwarding it', () => {
    expect(() =>
      parseBody(updateAgentSchema(), { extraction_config: { keys: [] } }),
    ).toThrow(/prompt/);
  });

  it('is still accompanied by extraction_enabled, which is a separate question', () => {
    expect(parseBody(updateAgentSchema(), { extraction_enabled: true })).toEqual({
      extraction_enabled: true,
    });
  });
});

/**
 * A dialed field, canonicalized on the way in for the same reason every
 * destination number is: one number typed two ways must not become two.
 */
describe('transfer_number', () => {
  it('is canonicalized to E.164', () => {
    expect(parseBody(updateAgentSchema(), { transfer_number: '+91 98765 43210' })).toEqual({
      transfer_number: '+919876543210',
    });
  });

  it('accepts null, which clears it', () => {
    expect(parseBody(updateAgentSchema(), { transfer_number: null })).toEqual({
      transfer_number: null,
    });
  });

  it('refuses a number that is not one', () => {
    expect(() => parseBody(updateAgentSchema(), { transfer_number: '+9109518550' })).toThrow(
      /transfer_number/,
    );
  });
});

/**
 * The knowledge-base tuning fields are gone from this surface. Not moved —
 * removed, and no longer forwarded, so an agent's stored values are left
 * exactly as they are and simply stop being editable here.
 */
describe('the removed knowledge-base fields', () => {
  it.each(['kb_threshold', 'kb_include_summaries', 'kb_result_format'])(
    'strips %s from an update rather than forwarding it',
    (field) => {
      const parsed = parseBody(updateAgentSchema(), { prompt: 'new', [field]: 'high' });

      expect(parsed).toEqual({ prompt: 'new' });
    },
  );

  it.each(['kb_threshold', 'kb_include_summaries', 'kb_result_format'])(
    'strips %s from a create rather than forwarding it',
    (field) => {
      const parsed = parseBody(createAgentSchema, { ...validCreate, [field]: 'high' });

      expect(parsed).not.toHaveProperty(field);
    },
  );
});

describe('WRITABLE_AGENT_FIELDS', () => {
  it('names both structured fields', () => {
    expect(WRITABLE_AGENT_FIELDS).toContain('transfer_destinations');
    expect(WRITABLE_AGENT_FIELDS).toContain('extraction_config');
  });

  it.each(['kb_threshold', 'kb_include_summaries', 'kb_result_format'])(
    'no longer names %s',
    (field) => {
      expect(WRITABLE_AGENT_FIELDS).not.toContain(field);
    },
  );
});

/**
 * The `ezo_` prefix is reserved.
 *
 * The dialer stamps `ezo_campaign_id` and three siblings onto every outbound
 * campaign call, and a post-call action's template keys on them. What makes
 * them trustworthy to a template is that nothing else can be called this —
 * so the two surfaces a variable name can be introduced from refuse the
 * prefix. This is the agent's declared list; the other is the campaign's CSV
 * column map.
 */
describe('the reserved ezo_ prefix', () => {
  const reject = (fn: () => unknown): { status: number; message: string } => {
    try {
      fn();
    } catch (err) {
      const e = err as { status: number; message: string };
      return { status: e.status, message: e.message };
    }
    throw new Error('expected the schema to refuse that');
  };

  it.each(['ezo_campaign_id', 'ezo_contact_id', 'ezo_anything_at_all', 'YE_CAMPAIGN_ID'])(
    'refuses %s in a create',
    (name) => {
      const failure = reject(() =>
        parseBody(createAgentSchema, {
          agent_name: 'A',
          prompt: 'p',
          voice_id: 'v',
          agent_type: 'inbound',
          variables: [name],
        }),
      );

      expect(failure.status).toBe(400);
      expect(failure.message).toContain('reserved');
    },
  );

  it('refuses one in an update, however many good names sit beside it', () => {
    const failure = reject(() =>
      parseBody(updateAgentSchema(), { variables: ['name', 'city', 'ezo_campaign_name'] }),
    );

    expect(failure.status).toBe(400);
  });

  it('still accepts an ordinary name that merely starts with e', () => {
    expect(
      parseBody(updateAgentSchema(), { variables: ['email', 'escalation_owner', 'ezra'] }),
    ).toEqual({ variables: ['email', 'escalation_owner', 'ezra'] });
  });
});
