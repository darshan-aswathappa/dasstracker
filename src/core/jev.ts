/**
 * Entry-level classification via Jev (OpenRouter's Decisions API).
 *
 * 3DS tags every posting with an experience band ("0 to 3 years", "4 to 5
 * years", ...). Jev turns that band into a yes/no entry-level verdict, which
 * the UI shows as a badge.
 *
 * Calls are made per distinct band rather than per job: the vocabulary is a
 * handful of fixed strings, so a few hundred jobs cost a few model calls.
 * Verdicts are persisted by the store, so a band is only ever asked about
 * again if a brand-new one appears.
 */

/** Entry level means "needs at most this many years" — 0, 1, 2 or 3. */
export const ENTRY_LEVEL_MAX_YEARS = 3;

const DEFAULT_URL = 'https://openrouter.ai/api/alpha/decisions';
/** Pinned: the threshold below was tuned against this version. */
const DEFAULT_MODEL = 'typesafe/jev-1.13';
/** A side must reach this probability to be a verdict; otherwise unknown. */
const DECIDE_AT = 0.6;
const REQUEST_TIMEOUT_MS = 30_000;

/** `entry` = 0-3 years, `senior` = more, `unknown` = Jev could not say. */
export type EntryLevelVerdict = 'entry' | 'senior' | 'unknown';

export interface JevConfig {
  apiKey: string;
  model: string;
  url: string;
}

export interface DecisionRequest {
  model: string;
  state: { experience_level: string };
  questions: {
    entry_level: {
      type: 'choice';
      instructions: string;
      criteria: Record<string, string>;
    };
  };
}

interface ChoiceAnswer {
  choice?: string;
  probabilities?: Record<string, number>;
}

export interface JevClassifier {
  configured: boolean;
  /** Verdict for one experience band. Blank input never reaches the model. */
  classify(experience: string): Promise<EntryLevelVerdict>;
  /** Verdicts for many bands, deduped: one model call per distinct band. */
  classifyAll(values: string[]): Promise<Map<string, EntryLevelVerdict>>;
}

/**
 * Read Jev settings from the environment. The key is the same OpenRouter key
 * boston-bot uses; absent it, classification is simply switched off.
 */
export function jevConfigFromEnv(env: NodeJS.ProcessEnv): JevConfig | null {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    model: env.JEV_MODEL?.trim() || DEFAULT_MODEL,
    url: env.JEV_URL?.trim() || DEFAULT_URL,
  };
}

/** Build the Decisions API body asking whether one band is entry level. */
export function buildDecisionRequest(experience: string, model: string): DecisionRequest {
  return {
    model,
    state: { experience_level: experience },
    questions: {
      entry_level: {
        type: 'choice',
        instructions:
          'A job posting states the experience level below. Decide whether this is an ' +
          `entry-level role. Entry level means the experience required is anywhere from 0 ` +
          `up to and including ${ENTRY_LEVEL_MAX_YEARS} years.`,
        criteria: {
          entry:
            'The stated experience falls entirely within 0 to ' +
            `${ENTRY_LEVEL_MAX_YEARS} years — for example "0 to ${ENTRY_LEVEL_MAX_YEARS} years", ` +
            '"new graduate", or "no experience required".',
          senior:
            `The stated experience requires more than ${ENTRY_LEVEL_MAX_YEARS} years, ` +
            'such as "4 to 5 years", "6 to 7 years", or "More than 15 years". A band that ' +
            `only partly overlaps 0 to ${ENTRY_LEVEL_MAX_YEARS} years still counts here.`,
          not_stated:
            'No experience level is stated, it is explicitly "Not specified", or it cannot ' +
            'be determined from the text.',
        },
      },
    },
  };
}

/**
 * Turn a Decisions API answer block into a verdict. Throws when the response
 * does not have the shape we rely on, so a changed API surfaces loudly rather
 * than silently classifying everything as unknown.
 */
export function verdictFromAnswers(answers: Record<string, ChoiceAnswer>): EntryLevelVerdict {
  const probs = answers?.entry_level?.probabilities;
  if (!probs || typeof probs !== 'object') {
    throw new Error('unexpected Jev response shape: missing entry_level probabilities');
  }
  const entry = Number(probs.entry ?? 0);
  const senior = Number(probs.senior ?? 0);
  if (entry >= DECIDE_AT) return 'entry';
  if (senior >= DECIDE_AT) return 'senior';
  return 'unknown';
}

/** Create a classifier. A null config yields a disabled, no-op classifier. */
export function createJevClassifier(
  config: JevConfig | null,
  fetchImpl: typeof fetch = fetch,
): JevClassifier {
  const configured = config !== null;

  async function ask(experience: string): Promise<EntryLevelVerdict> {
    if (!config) throw new Error('Jev is not configured (set OPENROUTER_API_KEY)');
    const res = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'dasstracker',
      },
      body: JSON.stringify(buildDecisionRequest(experience, config.model)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Jev HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const body = (await res.json()) as { answers?: Record<string, ChoiceAnswer> };
    return verdictFromAnswers(body?.answers as Record<string, ChoiceAnswer>);
  }

  const classify = async (experience: string): Promise<EntryLevelVerdict> => {
    const value = experience.trim();
    // Nothing to reason about, and an empty prompt would only burn a call.
    if (!value) return 'unknown';
    return ask(value);
  };

  const classifyAll = async (values: string[]): Promise<Map<string, EntryLevelVerdict>> => {
    const out = new Map<string, EntryLevelVerdict>();
    const distinct = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
    for (const value of distinct) {
      out.set(value, await classify(value));
    }
    return out;
  };

  return { configured, classify, classifyAll };
}
