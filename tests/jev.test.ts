import { describe, it, expect } from 'vitest';
import {
  jevConfigFromEnv,
  buildDecisionRequest,
  buildRoleRequest,
  roleFromAnswers,
  verdictFromAnswers,
  createJevClassifier,
  ENTRY_LEVEL_MAX_YEARS,
} from '../src/core/jev.js';

/** Fake fetch returning a canned Decisions API body. */
function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

/** A Decisions API answer block with the given probabilities. */
function answer(entry: number, senior: number, notStated = 0) {
  return {
    answers: {
      entry_level: {
        type: 'choice',
        choice: entry >= senior ? 'entry' : 'senior',
        probabilities: { entry, senior, not_stated: notStated },
      },
    },
  };
}

describe('jevConfigFromEnv', () => {
  it('returns null when the API key is missing', () => {
    expect(jevConfigFromEnv({})).toBeNull();
    expect(jevConfigFromEnv({ OPENROUTER_API_KEY: '   ' })).toBeNull();
  });

  it('builds a config from OPENROUTER_API_KEY', () => {
    const cfg = jevConfigFromEnv({ OPENROUTER_API_KEY: 'sk-or-v1-abc' });
    expect(cfg?.apiKey).toBe('sk-or-v1-abc');
    expect(cfg?.model).toContain('jev');
  });

  it('allows overriding the model', () => {
    const cfg = jevConfigFromEnv({ OPENROUTER_API_KEY: 'k', JEV_MODEL: 'typesafe/jev-2' });
    expect(cfg?.model).toBe('typesafe/jev-2');
  });
});

describe('buildDecisionRequest', () => {
  it('states the 0-3 year rule and puts the experience in the state', () => {
    const req = buildDecisionRequest('4 to 5 years', 'typesafe/jev-1.13');
    expect(req.model).toBe('typesafe/jev-1.13');
    expect(req.state.experience_level).toBe('4 to 5 years');
    expect(req.questions.entry_level.type).toBe('choice');
    expect(JSON.stringify(req.questions)).toContain(String(ENTRY_LEVEL_MAX_YEARS));
  });
});

describe('verdictFromAnswers', () => {
  it('reads a confident entry-level answer', () => {
    expect(verdictFromAnswers(answer(1, 0).answers)).toBe('entry');
  });

  it('reads a confident senior answer', () => {
    expect(verdictFromAnswers(answer(0, 1).answers)).toBe('senior');
  });

  it('returns unknown when neither side clears the threshold', () => {
    expect(verdictFromAnswers(answer(0.5, 0.5).answers)).toBe('unknown');
  });

  it('returns unknown when the model says the level is not stated', () => {
    expect(verdictFromAnswers(answer(0.1, 0.1, 0.8).answers)).toBe('unknown');
  });

  it('throws on an unrecognized response shape', () => {
    expect(() => verdictFromAnswers({} as never)).toThrow();
    expect(() => verdictFromAnswers({ entry_level: {} } as never)).toThrow();
  });
});

describe('createJevClassifier', () => {
  it('is unconfigured without a key and classifies nothing', async () => {
    const c = createJevClassifier(null);
    expect(c.configured).toBe(false);
    await expect(c.classify('0 to 3 years')).rejects.toThrow(/not configured/i);
  });

  it('classifies a single value', async () => {
    const c = createJevClassifier(
      { apiKey: 'k', model: 'm', url: 'https://x' },
      fakeFetch(answer(1, 0)),
    );
    expect(await c.classify('0 to 3 years')).toBe('entry');
  });

  it('raises on a non-OK HTTP response', async () => {
    const c = createJevClassifier(
      { apiKey: 'k', model: 'm', url: 'https://x' },
      fakeFetch({ error: 'nope' }, 401),
    );
    await expect(c.classify('0 to 3 years')).rejects.toThrow(/401/);
  });

  it('treats a blank experience as unknown without calling the model', async () => {
    let calls = 0;
    const counting: typeof fetch = (async () => {
      calls++;
      return { ok: true, status: 200, json: async () => answer(1, 0) };
    }) as unknown as typeof fetch;
    const c = createJevClassifier({ apiKey: 'k', model: 'm', url: 'https://x' }, counting);
    expect(await c.classify('  ')).toBe('unknown');
    expect(calls).toBe(0);
  });

  it('makes one call per distinct value, not per job', async () => {
    let calls = 0;
    const counting: typeof fetch = (async () => {
      calls++;
      return { ok: true, status: 200, json: async () => answer(1, 0) };
    }) as unknown as typeof fetch;
    const c = createJevClassifier({ apiKey: 'k', model: 'm', url: 'https://x' }, counting);
    const out = await c.classifyAll([
      '0 to 3 years',
      '0 to 3 years',
      '4 to 5 years',
      '0 to 3 years',
    ]);
    expect(calls).toBe(2);
    expect(out.get('0 to 3 years')).toBe('entry');
    expect(out.size).toBe(2);
  });
});

/** A role answer block with the given probabilities. */
function roleAnswer(ai: number, software: number, other = 0) {
  return {
    answers: {
      role_kind: {
        type: 'choice',
        choice: 'ai',
        probabilities: { ai, software, other },
      },
    },
  };
}

describe('buildRoleRequest', () => {
  const input = {
    title: 'AI/ML Developer',
    category: 'Research & Development',
    description: 'Train and deploy models on the 3DEXPERIENCE platform.',
  };

  it('carries the title, category and body it is judging', () => {
    const req = buildRoleRequest(input, 'typesafe/jev-1.13');
    expect(req.model).toBe('typesafe/jev-1.13');
    expect(req.state.title).toBe('AI/ML Developer');
    expect(req.state.category).toBe('Research & Development');
    expect(req.state.description).toContain('3DEXPERIENCE');
  });

  it('offers exactly the three kinds the resumes are keyed on', () => {
    const req = buildRoleRequest(input, 'm');
    expect(Object.keys(req.questions.role_kind.criteria).sort()).toEqual([
      'ai',
      'other',
      'software',
    ]);
  });

  it('trims a long posting rather than sending the whole thing', () => {
    const req = buildRoleRequest({ ...input, description: 'x'.repeat(10_000) }, 'm');
    expect(req.state.description.length).toBeLessThanOrEqual(4000);
  });
});

describe('roleFromAnswers', () => {
  it('reads each kind when it is confident enough', () => {
    expect(roleFromAnswers(roleAnswer(0.9, 0.05, 0.05).answers)).toBe('ai');
    expect(roleFromAnswers(roleAnswer(0.1, 0.85, 0.05).answers)).toBe('software');
    expect(roleFromAnswers(roleAnswer(0.1, 0.2, 0.7).answers)).toBe('other');
  });

  it('refuses to pick a side it is not confident about', () => {
    // A near-tie decides nothing: the wrong resume is worse than no application.
    expect(roleFromAnswers(roleAnswer(0.45, 0.45, 0.1).answers)).toBe('unknown');
    expect(roleFromAnswers(roleAnswer(0.59, 0.41).answers)).toBe('unknown');
  });

  it('throws on a response shape it does not recognise', () => {
    expect(() => roleFromAnswers({} as never)).toThrow(/role_kind/);
  });
});

describe('classifyRole', () => {
  it('asks Jev and reads back the verdict', async () => {
    const jev = createJevClassifier(
      { apiKey: 'k', model: 'm', url: 'https://x' },
      fakeFetch(roleAnswer(0.05, 0.9, 0.05)),
    );
    expect(
      await jev.classifyRole({ title: 'Cloud Engineer', category: 'IT', description: '' }),
    ).toBe('software');
  });

  it('does not spend a call on a posting with no title', async () => {
    let called = false;
    const jev = createJevClassifier({ apiKey: 'k', model: 'm', url: 'https://x' }, (async () => {
      called = true;
      throw new Error('should not be called');
    }) as unknown as typeof fetch);

    expect(await jev.classifyRole({ title: '  ', category: 'IT', description: 'x' })).toBe(
      'unknown',
    );
    expect(called).toBe(false);
  });

  it('surfaces an HTTP failure rather than reading it as a verdict', async () => {
    const jev = createJevClassifier(
      { apiKey: 'k', model: 'm', url: 'https://x' },
      fakeFetch({ error: 'nope' }, 500),
    );
    await expect(
      jev.classifyRole({ title: 'AI Engineer', category: 'R&D', description: '' }),
    ).rejects.toThrow(/500/);
  });
});
