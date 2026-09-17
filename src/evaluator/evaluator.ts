import type { Json } from '../core/types.js';

export interface EvalUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface Candidate {
  readonly key: string;
  readonly label: string;
}

export interface ScreenInput {
  readonly state: string | Json;
  /** Pergunta booleana aplicada a cada candidato. */
  readonly question: string;
  readonly candidates: readonly Candidate[];
}

export interface ScreenResult {
  /** P(true) cru, por chave de candidato, como o modelo devolveu. */
  readonly probability: Readonly<Record<string, number>>;
  readonly usage: EvalUsage;
  readonly calls: number;
}

export interface PriorsInput {
  readonly state: string | Json;
  readonly question: string;
  readonly candidates: readonly Candidate[];
}

export interface PriorsResult {
  /** Distribuicao normalizada sobre as chaves; soma 1. */
  readonly distribution: Readonly<Record<string, number>>;
  /** Chave escolhida pelo modelo (o argmax declarado). */
  readonly top: string;
  readonly usage: EvalUsage;
  readonly calls: number;
}

export interface ValueInput {
  readonly state: string | Json;
  readonly question: string;
  /** Niveis da rubrica, do pior para o melhor. Minimo 2. */
  readonly levels: readonly string[];
}

export interface ValueResult {
  /** Score normalizado em [0,1] = score_bruto / (levels.length - 1). */
  readonly value: number;
  /** Score bruto devolvido pelo modelo, em [0, levels.length - 1]. */
  readonly raw: number;
  readonly usage: EvalUsage;
  readonly calls: number;
}

/**
 * A superficie que a busca usa. Tres formas, exatamente as tres primitivas do
 * Jev, e nada mais: nenhum metodo devolve texto livre e nenhum inventa estado.
 */
export interface Evaluator {
  readonly id: string;
  screen(input: ScreenInput): Promise<ScreenResult>;
  priors(input: PriorsInput): Promise<PriorsResult>;
  value(input: ValueInput): Promise<ValueResult>;
}

export const EMPTY_USAGE: EvalUsage = Object.freeze({ inputTokens: 0, outputTokens: 0 });

/** Normaliza para uma distribuicao valida, com suavizacao uniforme. */
export function normalizeDistribution(
  weights: Readonly<Record<string, number>>,
  keys: readonly string[],
  epsilon = 1e-3,
): Record<string, number> {
  const out: Record<string, number> = {};
  let sum = 0;
  for (const key of keys) {
    const raw = weights[key];
    const w = Number.isFinite(raw) && (raw as number) > 0 ? (raw as number) : 0;
    out[key] = w;
    sum += w;
  }
  if (sum <= 0) {
    const uniform = 1 / Math.max(1, keys.length);
    for (const key of keys) out[key] = uniform;
    return out;
  }
  const floor = epsilon / Math.max(1, keys.length);
  let renorm = 0;
  for (const key of keys) {
    const v = (out[key] as number) / sum;
    const smoothed = (1 - epsilon) * v + floor;
    out[key] = smoothed;
    renorm += smoothed;
  }
  for (const key of keys) out[key] = (out[key] as number) / renorm;
  return out;
}
