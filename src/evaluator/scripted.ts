import { digest, stableStringify } from '../core/hash.js';
import { normalizeDistribution } from './evaluator.js';
import type {
  Evaluator,
  PriorsInput,
  PriorsResult,
  ScreenInput,
  ScreenResult,
  ValueInput,
  ValueResult,
} from './evaluator.js';

/**
 * Avaliador offline e determinista. Nao e um mock de conveniencia: e o
 * substituto honesto do Jev para a suite, para o replay e para medir a busca sem
 * confundir "a busca funciona" com "o classificador acertou".
 *
 * O chamador fornece a heuristica. Sem heuristica ele devolve ruido estavel
 * derivado do hash do par (estado, candidato) -- util para provar que a busca
 * ainda converge quando o prior nao vale nada.
 */
export interface ScriptedHeuristic {
  /** Qualidade percebida do candidato naquele estado, em [0,1]. */
  candidate?(state: unknown, label: string): number;
  /** Valor percebido do estado, em [0,1]. */
  state?(state: unknown): number;
}

export interface ScriptedOptions {
  readonly id?: string;
  readonly heuristic?: ScriptedHeuristic;
  /** Ruido determinista somado a heuristica, amplitude em [0,1]. Default 0. */
  readonly noise?: number;
  /** Tokens fingidos por chamada, para o orcamento ser exercitado nos testes. */
  readonly tokensPerCall?: number;
}

function hashUnit(...parts: unknown[]): number {
  const hex = digest(parts).slice(0, 8);
  return parseInt(hex, 16) / 0xffffffff;
}

export function createScriptedEvaluator(options: ScriptedOptions = {}): Evaluator {
  const id = options.id ?? 'scripted';
  const noise = options.noise ?? 0;
  const tokens = options.tokensPerCall ?? 400;
  const usageFor = (n: number) => ({ inputTokens: tokens * n, outputTokens: 8 * n });

  const scoreCandidate = (state: unknown, label: string): number => {
    const base = options.heuristic?.candidate?.(state, label) ?? 0.5;
    const jitter = noise > 0 ? (hashUnit(stableStringify(state), label) - 0.5) * 2 * noise : 0;
    return Math.min(1, Math.max(0, base + jitter));
  };

  return {
    id,

    async screen(input: ScreenInput): Promise<ScreenResult> {
      const probability: Record<string, number> = {};
      for (const candidate of input.candidates) {
        probability[candidate.key] = scoreCandidate(input.state, candidate.label);
      }
      return { probability, usage: usageFor(1), calls: 1 };
    },

    async priors(input: PriorsInput): Promise<PriorsResult> {
      const weights: Record<string, number> = {};
      for (const candidate of input.candidates) {
        // Softmax leve: o Jev devolve distribuicao, nao ranking cru.
        weights[candidate.key] = Math.exp(3 * scoreCandidate(input.state, candidate.label));
      }
      const keys = input.candidates.map((c) => c.key);
      const distribution = normalizeDistribution(weights, keys);
      const top = keys.reduce(
        (best, key) => ((distribution[key] ?? 0) > (distribution[best] ?? 0) ? key : best),
        keys[0] ?? '',
      );
      return { distribution, top, usage: usageFor(1), calls: 1 };
    },

    async value(input: ValueInput): Promise<ValueResult> {
      const base =
        options.heuristic?.state?.(input.state) ?? hashUnit('value', stableStringify(input.state));
      const span = input.levels.length - 1;
      const clamped = Math.min(1, Math.max(0, base));
      return { value: clamped, raw: clamped * span, usage: usageFor(1), calls: 1 };
    },
  };
}
