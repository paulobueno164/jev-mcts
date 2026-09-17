import type { Action, Decision, Json } from '../core/types.js';
import type { Journal } from '../core/journal.js';
import type { Environment } from '../env/environment.js';
import type { Evaluator } from '../evaluator/evaluator.js';
import { identityCalibration, type Calibration } from '../evaluator/calibration.js';
import { EvaluatorUnavailableError } from '../evaluator/resilient.js';
import {
  DEFAULT_SEARCH,
  search,
  type SearchConfig,
  type SearchOutcome,
  type SearchStats,
} from '../search/mcts.js';
import { applyGates, DEFAULT_GATES, type GateConfig, type GateVerdict } from './gates.js';
import { haltingPort, type HumanDecision, type HumanPort } from './human.js';
import { createOverrideStore, stateKeyOf, type OverrideStore } from './overrides.js';

/**
 * Como a acao escolhida vira realidade. Por padrao e `env.apply` -- util para
 * demonstracao. Num uso real este e o lugar onde se roda o comando e se OBSERVA
 * o resultado: a busca pode ser especulativa, a execucao nunca e.
 */
export type Executor<S> = (state: S, action: Action) => Promise<S> | S;

export interface OrchestratorOptions<S> {
  readonly env: Environment<S>;
  readonly evaluator: Evaluator;
  readonly goal: string;
  readonly search?: Partial<SearchConfig>;
  readonly gates?: Partial<GateConfig>;
  readonly human?: HumanPort;
  readonly journal?: Journal;
  readonly calibration?: Calibration;
  readonly overrides?: OverrideStore;
  readonly executor?: Executor<S>;
  readonly maxSteps?: number;
  /** Quantas re-buscas o passo aceita depois de um "recusar". Default 2. */
  readonly maxRetriesPerStep?: number;
}

/**
 * Uma proposta dentro de um passo. Um passo pode ter varias: cada recusa humana
 * derruba uma proposta e obriga a busca a refazer o plano. Todas ficam no
 * registro -- uma proposta recusada e informacao, nao lixo.
 */
export interface Attempt {
  readonly attempt: number;
  readonly decision: Decision | null;
  readonly verdict: GateVerdict;
  readonly stats: SearchStats;
  readonly human: { readonly port: string; readonly decision: HumanDecision } | null;
}

export interface StepRecord {
  readonly step: number;
  readonly attempts: readonly Attempt[];
  readonly applied: Action | null;
}

export type StopReason =
  | 'terminal'
  | 'max-steps'
  | 'aborted'
  | 'blocked'
  /** O avaliador caiu e nao voltou. Parada limpa: o que ja foi feito continua feito. */
  | 'evaluator-unavailable';

export interface RunResult<S> {
  readonly goal: string;
  readonly finalState: S;
  readonly steps: readonly StepRecord[];
  readonly stopped: StopReason;
  readonly totals: {
    readonly evaluatorCalls: number;
    readonly inputTokens: number;
    readonly usd: number;
    readonly wallMs: number;
    readonly escalations: number;
    readonly autonomous: number;
    readonly rejections: number;
  };
  /** O que o relatorio NAO tem direito de esconder. */
  readonly provenance: {
    readonly fidelity: Environment<S>['fidelity'];
    readonly depthCap: number;
    readonly depthCapClamped: boolean;
    readonly calibrated: boolean;
    /** Decisoes em que TODAS as folhas foram medidas pelo ambiente. */
    readonly groundedDecisions: number;
    /** Decisoes com ao menos uma folha estimada pelo avaliador. */
    readonly speculativeDecisions: number;
    /** Contagem de folhas, somada sobre a corrida: o denominador honesto. */
    readonly measuredLeaves: number;
    readonly estimatedLeaves: number;
    readonly humanPort: string;
  };
}

/** Todas as propostas de todos os passos, na ordem em que foram feitas. */
export function allAttempts<S>(result: RunResult<S>): Attempt[] {
  return result.steps.flatMap((step) => [...step.attempts]);
}

export async function run<S>(initial: S, options: OrchestratorOptions<S>): Promise<RunResult<S>> {
  const env = options.env;
  const config: SearchConfig = { ...DEFAULT_SEARCH, ...options.search };
  const gates: GateConfig = { ...DEFAULT_GATES, ...options.gates };
  const human = options.human ?? haltingPort();
  const journal = options.journal;
  const calibration = options.calibration ?? identityCalibration(options.evaluator.id);
  const overrides = options.overrides ?? createOverrideStore();
  const execute: Executor<S> = options.executor ?? ((state, action) => env.apply(state, action));
  const maxSteps = options.maxSteps ?? 12;
  const maxRetries = options.maxRetriesPerStep ?? 2;
  const startedAt = Date.now();

  journal?.write('run.start', {
    goal: options.goal,
    env: env.name,
    fidelity: env.fidelity,
    evaluator: options.evaluator.id,
    humanPort: human.id,
    calibrated: calibration.fitted,
    iterations: config.iterations,
    seed: String(config.seed),
    maxSteps,
    maxRetriesPerStep: maxRetries,
    // O replay so reproduz se os portoes forem os mesmos: eles entram no registro.
    gates: gates as unknown as Json,
  });

  let state = initial;
  const steps: StepRecord[] = [];
  let stopped: StopReason = 'max-steps';
  const totals = {
    evaluatorCalls: 0,
    inputTokens: 0,
    usd: 0,
    wallMs: 0,
    escalations: 0,
    autonomous: 0,
    rejections: 0,
  };
  let depthCap = config.maxDepth;
  let depthCapClamped = false;
  let groundedDecisions = 0;
  let speculativeDecisions = 0;

  let measuredLeaves = 0;
  let estimatedLeaves = 0;

  const countProvenance = (decision: Decision): void => {
    // Uma unica folha estimada ja tira a decisao da coluna "medida". O resumo
    // do rodape pode arredondar; esta contagem nao.
    if (decision.groundedFraction >= 1) groundedDecisions += 1;
    else speculativeDecisions += 1;
    for (const [source, count] of Object.entries(decision.valueSources)) {
      if (source === 'grounded-reward' || source === 'grounded-rollout') measuredLeaves += count;
      else estimatedLeaves += count;
    }
  };

  for (let step = 1; step <= maxSteps; step++) {
    if (env.terminal(state)) {
      stopped = 'terminal';
      break;
    }
    const legal = env.actions(state);
    if (legal.length === 0) {
      stopped = 'blocked';
      break;
    }

    const stateView = env.render(state);
    const stateKey = stateKeyOf(
      stateView,
      legal.map((a) => a.key),
    );

    const attempts: Attempt[] = [];
    let applied: Action | null = null;
    let halt: StopReason | null = null;

    for (let attempt = 1; ; attempt++) {
      const priorOverride = overrides.priorFor(stateKey);
      const banned = overrides.lookup(stateKey)?.banned ?? [];
      // O avaliador e rede: 429, queda de provedor e timeout acontecem no meio de
      // uma corrida longa. Deixar isso subir como excecao nao tratada mata a
      // corrida inteira e leva junto o que ja estava feito — que e exatamente o
      // oposto do que a secao 8 do CLAUDE.md exige de um limite estourado.
      let outcome: SearchOutcome<S>;
      try {
        outcome = await search(state, {
          env,
          evaluator: options.evaluator,
          calibration,
          ...(journal ? { journal } : {}),
          config: {
            ...config,
            seed: `${String(config.seed)}:${step}:${attempt}`,
            ...(priorOverride ? { priorOverride } : {}),
            ...(banned.length > 0 ? { bannedAtRoot: banned } : {}),
          },
        });
      } catch (error) {
        // So o avaliador fora do ar vira parada limpa. Qualquer outra excecao e
        // bug, e bug tem que estourar.
        if (!(error instanceof EvaluatorUnavailableError)) throw error;
        journal?.write('evaluator.unavailable', {
          step,
          attempt,
          evaluator: options.evaluator.id,
          message: error.message,
        });
        halt = 'evaluator-unavailable';
        break;
      }

      totals.evaluatorCalls += outcome.stats.evaluatorCalls;
      totals.inputTokens += outcome.stats.budget.inputTokens;
      totals.usd += outcome.stats.budget.usd;
      depthCap = outcome.stats.depthCap;
      depthCapClamped = depthCapClamped || outcome.stats.depthCapClamped;

      const verdict = applyGates(outcome.decision, outcome.stats, gates);
      journal?.write('gate', {
        step,
        attempt,
        outcome: verdict.outcome,
        action: outcome.decision?.action.key ?? null,
        risk: outcome.decision?.action.risk ?? null,
        reasons: verdict.reasons.map((r) => r.code),
      });

      const base = { attempt, decision: outcome.decision, verdict, stats: outcome.stats };

      if (verdict.outcome === 'proceed' && outcome.decision) {
        totals.autonomous += 1;
        countProvenance(outcome.decision);
        state = await execute(state, outcome.decision.action);
        applied = outcome.decision.action;
        journal?.write('act', {
          step,
          action: applied.key,
          via: 'autonomo',
          valueSource: outcome.decision.valueSource,
        });
        attempts.push({ ...base, human: null });
        break;
      }

      totals.escalations += 1;
      if (!outcome.decision) {
        attempts.push({ ...base, human: null });
        halt = 'blocked';
        break;
      }

      journal?.write('human.request', {
        step,
        attempt,
        action: outcome.decision.action.key,
        risk: outcome.decision.action.risk,
        reasons: verdict.reasons as unknown as Json,
      });
      const answer = await human.decide({
        step,
        goal: options.goal,
        stateView: typeof stateView === 'string' ? stateView : JSON.stringify(stateView, null, 2),
        decision: outcome.decision,
        reasons: verdict.reasons,
        spent: {
          calls: outcome.stats.evaluatorCalls,
          usd: outcome.stats.budget.usd,
          wallMs: outcome.stats.budget.wallMs,
        },
      });
      journal?.write('human.decision', {
        step,
        attempt,
        port: human.id,
        answer: answer as unknown as Json,
      });
      attempts.push({ ...base, human: { port: human.id, decision: answer } });

      if (answer.kind === 'approve') {
        overrides.force(stateKey, outcome.decision.action.key, answer.note);
        countProvenance(outcome.decision);
        state = await execute(state, outcome.decision.action);
        applied = outcome.decision.action;
        journal?.write('act', { step, action: applied.key, via: 'aprovado' });
        break;
      }

      if (answer.kind === 'choose') {
        const chosen = legal.find((a) => a.key === answer.key);
        if (!chosen) {
          halt = 'aborted';
          break;
        }
        overrides.force(stateKey, chosen.key, answer.note);
        countProvenance(outcome.decision);
        state = await execute(state, chosen);
        applied = chosen;
        journal?.write('act', { step, action: chosen.key, via: 'escolha-humana' });
        break;
      }

      if (answer.kind === 'amend') {
        if (!env.amend) {
          halt = 'aborted';
          break;
        }
        state = env.amend(state, answer.instruction);
        journal?.write('act', { step, action: '(emenda)', via: 'emenda-humana' });
        break;
      }

      if (answer.kind === 'reject') {
        totals.rejections += 1;
        overrides.ban(stateKey, outcome.decision.action.key, answer.note);
        if (attempt > maxRetries) {
          halt = 'blocked';
          break;
        }
        continue;
      }

      halt = 'aborted';
      break;
    }

    steps.push({ step, attempts, applied });
    if (halt) {
      stopped = halt;
      break;
    }
  }

  totals.wallMs = Date.now() - startedAt;
  const result: RunResult<S> = {
    goal: options.goal,
    finalState: state,
    steps,
    stopped,
    totals,
    provenance: {
      fidelity: env.fidelity,
      depthCap,
      depthCapClamped,
      calibrated: calibration.fitted,
      groundedDecisions,
      speculativeDecisions,
      measuredLeaves,
      estimatedLeaves,
      humanPort: human.id,
    },
  };
  journal?.write('run.end', {
    stopped,
    steps: steps.length,
    escalations: totals.escalations,
    rejections: totals.rejections,
    autonomous: totals.autonomous,
    evaluatorCalls: totals.evaluatorCalls,
    usd: totals.usd,
    wallMs: totals.wallMs,
  });
  return result;
}
