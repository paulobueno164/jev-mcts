import type { Json } from '../core/types.js';
import { makeRng } from '../core/rng.js';
import { normalizeDistribution } from './evaluator.js';
import type {
  Candidate,
  EvalUsage,
  Evaluator,
  PriorsInput,
  PriorsResult,
  ScreenInput,
  ScreenResult,
  ValueInput,
  ValueResult,
} from './evaluator.js';

export interface JevOptions {
  /** Id do modelo no AI Gateway. Default: typesafe-ai/jev */
  readonly model?: string;
  /**
   * Quantas perguntas booleanas cabem numa chamada. O Jev aceita 1 estado com N
   * perguntas, e o contexto e de ~32k tokens: mais que isso e truncar o estado.
   */
  readonly maxQuestionsPerCall?: number;
  /**
   * 1 = uma passada. 2 = repete com a ordem dos candidatos invertida e tira a
   * media. Classificador tem vies de posicao; 2 passadas custam o dobro e
   * removem o vies de ordem. Default: 1.
   */
  readonly debiasPasses?: 1 | 2;
  /** Semente do embaralhamento de candidatos. Fixa => chamada reproduzivel. */
  readonly seed?: number | string;
  /**
   * Default: true. Medido em 17/09/2026: o Gateway devolve 500 com
   * "ZDR is only available for Pro and Enterprise plans" em conta hobby —
   * a chamada inteira e recusada antes de avaliar qualquer coisa. Desligar e
   * escolha explicita de quem esta rodando, e o prompt vai para o provider.
   */
  readonly zeroDataRetention?: boolean;
  readonly maxRetries?: number;
  readonly abortSignal?: AbortSignal;
}

type AnyRecord = Record<string, unknown>;

interface EvaluateResult {
  answers: Record<string, AnyRecord>;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  warnings?: unknown;
  providerMetadata?: AnyRecord;
}

type EvaluateFn = (args: AnyRecord) => Promise<EvaluateResult>;

let cachedEvaluate: EvaluateFn | null = null;

async function loadEvaluate(): Promise<EvaluateFn> {
  if (cachedEvaluate) return cachedEvaluate;
  let mod: AnyRecord;
  try {
    mod = (await import('ai')) as unknown as AnyRecord;
  } catch {
    throw new Error(
      'O pacote "ai" nao esta instalado. Rode `pnpm add ai@latest` (>=7.0.105) ou use --evaluator scripted.',
    );
  }
  const fn = (mod['experimental_evaluate'] ?? mod['evaluate']) as EvaluateFn | undefined;
  if (typeof fn !== 'function') {
    throw new Error(
      'A versao instalada de "ai" nao expoe experimental_evaluate. Exige AI SDK >= 7.0.105.',
    );
  }
  cachedEvaluate = fn;
  return fn;
}

/**
 * A credencial utilizavel, ou null.
 *
 * Duas armadilhas medidas em 17/09/2026, ambas com chave de verdade na mao:
 *
 *  1. `.env.example` distribui as duas variaveis VAZIAS. `a ?? b` so cai para
 *     `b` em null/undefined, entao `AI_GATEWAY_API_KEY=` (string vazia) fazia o
 *     fallback nunca acontecer e a guarda mentir nos dois sentidos.
 *  2. O AI SDK le **so** `AI_GATEWAY_API_KEY`. `TYPESAFE_AI_API_KEY` era aceita
 *     por toda guarda do repositorio e ignorada na hora da chamada: guarda
 *     verde, 401 no servidor. Aqui ela vira alias de verdade.
 */
export function resolveJevCredential(
  env: NodeJS.ProcessEnv = process.env,
): { readonly key: string; readonly source: 'AI_GATEWAY_API_KEY' | 'TYPESAFE_AI_API_KEY' } | null {
  const gateway = (env['AI_GATEWAY_API_KEY'] ?? '').trim();
  if (gateway) return { key: gateway, source: 'AI_GATEWAY_API_KEY' };
  const typesafe = (env['TYPESAFE_AI_API_KEY'] ?? '').trim();
  if (typesafe) return { key: typesafe, source: 'TYPESAFE_AI_API_KEY' };
  return null;
}

export function jevCredentialsPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveJevCredential(env) !== null;
}

const zeroUsage: EvalUsage = { inputTokens: 0, outputTokens: 0 };

function readUsage(result: EvaluateResult): EvalUsage {
  return {
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
  };
}

function addUsage(a: EvalUsage, b: EvalUsage): EvalUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

function slateState(context: string | Json, ordered: readonly Candidate[], offset: number): Json {
  return {
    context: context as Json,
    candidates: ordered.map((c, i) => ({ ref: 'c' + String(offset + i), action: c.label })),
  };
}

/**
 * Adaptador do TypeSafe Jev via AI SDK.
 *
 * Tres decisoes que o separam de uma chamada ingenua:
 *  1. Uma chamada carrega N perguntas sobre UM estado (e o que a API permite);
 *     a triagem de candidatos vira um slate unico em vez de N chamadas.
 *  2. A ordem dos candidatos e embaralhada por RNG semeado antes de virar
 *     pergunta, porque classificador tem vies de posicao. debiasPasses: 2
 *     repete com a ordem invertida e tira a media.
 *  3. Nada aqui devolve texto: so escolha, nota e probabilidade.
 */
export function createJevEvaluator(options: JevOptions = {}): Evaluator {
  // O provider do Gateway le a chave do ambiente, e so conhece um nome. Se a
  // credencial veio pelo alias, ela precisa estar sob o nome que ele le antes
  // da primeira chamada — senao a guarda passa e o servidor recusa.
  const credential = resolveJevCredential();
  if (credential?.source === 'TYPESAFE_AI_API_KEY') {
    process.env['AI_GATEWAY_API_KEY'] = credential.key;
  }
  const model = options.model ?? process.env['JEV_MODEL'] ?? 'typesafe-ai/jev';
  const chunkSize = Math.max(1, options.maxQuestionsPerCall ?? 16);
  const passes = options.debiasPasses ?? 1;
  const rngSeed = options.seed ?? 'jev';

  const baseArgs = (): AnyRecord => {
    const args: AnyRecord = { model, maxRetries: options.maxRetries ?? 2 };
    if (options.abortSignal) args['abortSignal'] = options.abortSignal;
    if (options.zeroDataRetention !== false) {
      args['providerOptions'] = { gateway: { zeroDataRetention: true } };
    }
    return args;
  };

  const orderings = (items: readonly Candidate[], tag: string): Candidate[][] => {
    const rng = makeRng(String(rngSeed) + ':' + tag);
    const first = rng.shuffled(items);
    return passes === 2 ? [first, first.slice().reverse()] : [first];
  };

  return {
    id: 'jev:' + model,

    async screen(input: ScreenInput): Promise<ScreenResult> {
      const evaluate = await loadEvaluate();
      const sums = new Map<string, { total: number; n: number }>();
      let usage = zeroUsage;
      let calls = 0;

      for (const ordered of orderings(input.candidates, 'screen')) {
        for (let start = 0; start < ordered.length; start += chunkSize) {
          const chunk = ordered.slice(start, start + chunkSize);
          const questions: AnyRecord = {};
          chunk.forEach((candidate, i) => {
            questions['q' + String(i)] = {
              type: 'boolean',
              instructions:
                input.question + '\nAcao avaliada: "' + candidate.label + '" (ref c' + String(start + i) + ').',
            };
          });
          const result = await evaluate({
            ...baseArgs(),
            state: slateState(input.state, chunk, start),
            questions,
          });
          calls += 1;
          usage = addUsage(usage, readUsage(result));
          chunk.forEach((candidate, i) => {
            const answer = result.answers['q' + String(i)];
            const p = Number(answer?.['probability']);
            const value = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0.5;
            const acc = sums.get(candidate.key) ?? { total: 0, n: 0 };
            acc.total += value;
            acc.n += 1;
            sums.set(candidate.key, acc);
          });
        }
      }

      const probability: Record<string, number> = {};
      for (const candidate of input.candidates) {
        const acc = sums.get(candidate.key);
        probability[candidate.key] = acc && acc.n > 0 ? acc.total / acc.n : 0.5;
      }
      return { probability, usage, calls };
    },

    async priors(input: PriorsInput): Promise<PriorsResult> {
      const evaluate = await loadEvaluate();
      const weights = new Map<string, { total: number; n: number }>();
      let usage = zeroUsage;
      let calls = 0;
      let declaredTop: string | null = null;

      for (const ordered of orderings(input.candidates, 'priors')) {
        const criteria: Record<string, string> = {};
        const refToKey = new Map<string, string>();
        ordered.forEach((candidate, i) => {
          criteria['c' + String(i)] = candidate.label;
          refToKey.set('c' + String(i), candidate.key);
        });
        const result = await evaluate({
          ...baseArgs(),
          state: input.state as Json,
          questions: {
            pick: { type: 'choice', instructions: input.question, criteria },
          },
        });
        calls += 1;
        usage = addUsage(usage, readUsage(result));

        const answer = result.answers['pick'] ?? {};
        const chosenRef = String(answer['choice'] ?? '');
        const chosenKey = refToKey.get(chosenRef);
        if (chosenKey && declaredTop === null) declaredTop = chosenKey;

        const probs = answer['probabilities'] as Record<string, number> | undefined;
        for (const [ref, key] of refToKey) {
          const raw = probs ? Number(probs[ref]) : ref === chosenRef ? 1 : 0;
          const value = Number.isFinite(raw) ? Math.max(0, raw) : 0;
          const acc = weights.get(key) ?? { total: 0, n: 0 };
          acc.total += value;
          acc.n += 1;
          weights.set(key, acc);
        }
      }

      const keys = input.candidates.map((c) => c.key);
      const averaged: Record<string, number> = {};
      for (const key of keys) {
        const acc = weights.get(key);
        averaged[key] = acc && acc.n > 0 ? acc.total / acc.n : 0;
      }
      const distribution = normalizeDistribution(averaged, keys);
      const fallbackTop = keys.reduce(
        (best, key) => ((distribution[key] ?? 0) > (distribution[best] ?? 0) ? key : best),
        keys[0] ?? '',
      );
      return { distribution, top: declaredTop ?? fallbackTop, usage, calls };
    },

    async value(input: ValueInput): Promise<ValueResult> {
      if (input.levels.length < 2) throw new Error('value(): a rubrica precisa de >= 2 niveis');
      const evaluate = await loadEvaluate();
      const result = await evaluate({
        ...baseArgs(),
        state: input.state as Json,
        questions: {
          v: { type: 'score', instructions: input.question, criteria: input.levels.slice() },
        },
      });
      const raw = Number(result.answers['v']?.['score']);
      const span = input.levels.length - 1;
      const safeRaw = Number.isFinite(raw) ? Math.min(span, Math.max(0, raw)) : span / 2;
      return { value: safeRaw / span, raw: safeRaw, usage: readUsage(result), calls: 1 };
    },
  };
}
