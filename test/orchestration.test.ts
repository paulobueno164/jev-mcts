import { describe, expect, it } from 'vitest';
import { createJournal } from '../src/core/journal.js';
import { createScriptedEvaluator } from '../src/evaluator/scripted.js';
import { replayOnly, withCache } from '../src/evaluator/cache.js';
import { autoApprovePort, haltingPort, scriptedPort } from '../src/orchestration/human.js';
import { createOverrideStore, stateKeyOf } from '../src/orchestration/overrides.js';
import { allAttempts, run } from '../src/orchestration/orchestrator.js';
import {
  createDevTaskEnv,
  createDevTaskExecutor,
  devTaskHeuristic,
  initialState,
} from '../examples/devtask/env.js';
import type { HumanDecision, HumanPort } from '../src/orchestration/human.js';

const GOAL = 'Corrigir o calculo de desconto e publicar a correcao em producao';

const evaluator = () =>
  createScriptedEvaluator({ id: 'scripted:devtask', heuristic: devTaskHeuristic() });

const baseOptions = () => ({
  env: createDevTaskEnv(),
  goal: GOAL,
  executor: createDevTaskExecutor(),
  maxSteps: 10,
  search: { iterations: 100, seed: 'teste', budget: { calls: 2000, wallMs: 20_000 } },
  gates: { escalateOnSpeculativeValue: false, escalateAtOrAbove: 'costly' as const },
});

/** Humano que recusa producao e aprova o resto — a politica da demonstracao. */
function policyPort(): HumanPort {
  return {
    id: 'politica',
    async decide(request) {
      const key = request.decision.action.key;
      if (key === 'publicar' || key === 'refatorar' || key === 'apagar-branch') {
        return { kind: 'reject', note: `recusado: ${key}` };
      }
      return { kind: 'approve' };
    },
  };
}

describe('orquestracao', () => {
  it('nunca aplica a acao irreversivel recusada, e o portao dela dispara', async () => {
    const result = await run(initialState(GOAL), {
      ...baseOptions(),
      evaluator: evaluator(),
      human: policyPort(),
    });
    expect(result.steps.some((s) => s.applied?.key === 'publicar')).toBe(false);
    const reasons = allAttempts(result).flatMap((a) => a.verdict.reasons.map((r) => r.code));
    expect(reasons).toContain('irreversible-action');
    expect(result.stopped).toBe('blocked');
    expect(result.totals.rejections).toBeGreaterThan(0);
  });

  it('uma recusa muda a acao aplicada naquele passo', async () => {
    const result = await run(initialState(GOAL), {
      ...baseOptions(),
      evaluator: evaluator(),
      human: policyPort(),
    });
    const contested = result.steps.find((step) => step.attempts.length > 1);
    expect(contested).toBeDefined();
    const rejected = contested?.attempts[0]?.decision?.action.key;
    expect(rejected).toBe('publicar');
    expect(contested?.applied?.key).not.toBe(rejected);
  });

  it('a recusa fica gravada como proibicao para aquele estado', async () => {
    const overrides = createOverrideStore();
    await run(initialState(GOAL), {
      ...baseOptions(),
      evaluator: evaluator(),
      human: policyPort(),
      overrides,
    });
    const banned = overrides.entries().filter((entry) => entry.banned.includes('publicar'));
    expect(banned.length).toBeGreaterThan(0);
    const prior = overrides.priorFor((banned[0] as { stateKey: string }).stateKey);
    expect(prior?.['publicar']).toBeLessThan(0.01);
  });

  it('sem porta humana, escalar significa parar — nunca seguir em frente', async () => {
    const result = await run(initialState(GOAL), {
      ...baseOptions(),
      evaluator: evaluator(),
      human: haltingPort(),
      gates: { escalateOnSpeculativeValue: true },
    });
    expect(result.stopped).toBe('aborted');
    expect(result.steps.every((step) => step.applied === null)).toBe(true);
  });

  it('nem o auto-approve aprova acao irreversivel', async () => {
    const result = await run(initialState(GOAL), {
      ...baseOptions(),
      evaluator: evaluator(),
      human: autoApprovePort(),
    });
    expect(result.steps.some((step) => step.applied?.key === 'publicar')).toBe(false);
    expect(result.stopped).toBe('aborted');
  });

  it('abortar interrompe o laco na hora', async () => {
    const result = await run(initialState(GOAL), {
      ...baseOptions(),
      evaluator: evaluator(),
      human: scriptedPort([{ kind: 'abort', note: 'parei' }]),
      gates: { escalateOnSpeculativeValue: true },
    });
    expect(result.stopped).toBe('aborted');
    expect(result.steps).toHaveLength(1);
  });

  it('o executor e quem transforma suposicao em observacao', async () => {
    const result = await run(initialState(GOAL), {
      ...baseOptions(),
      evaluator: evaluator(),
      human: policyPort(),
    });
    const facts = result.finalState.facts;
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every((fact) => fact.startsWith('observado:'))).toBe(true);
  });
});

describe('replay', () => {
  it('refaz a corrida sem rede e chega na mesma sequencia de acoes', async () => {
    const cached = withCache(evaluator());
    const liveJournal = createJournal(null);
    const script: HumanDecision[] = [];
    const recordingPort: HumanPort = {
      id: 'gravando',
      async decide(request) {
        const answer = await policyPort().decide(request);
        script.push(answer);
        return answer;
      },
    };

    const live = await run(initialState(GOAL), {
      ...baseOptions(),
      evaluator: cached,
      human: recordingPort,
      journal: liveJournal,
    });

    const replayJournal = createJournal(null);
    const replayed = await run(initialState(GOAL), {
      ...baseOptions(),
      evaluator: replayOnly(cached.dump(), 'scripted:devtask'),
      human: scriptedPort(script, 'replay'),
      journal: replayJournal,
    });

    const keys = (result: typeof live) =>
      result.steps.map((step) => step.applied?.key ?? '(nenhuma)');
    expect(keys(replayed)).toEqual(keys(live));
    expect(replayed.totals.evaluatorCalls).toBe(0);
    expect(replayed.totals.usd).toBe(0);
    expect(live.totals.evaluatorCalls).toBeGreaterThan(0);
  });
});

describe('stateKeyOf', () => {
  it('a ordem das acoes nao muda a assinatura do estado', () => {
    expect(stateKeyOf({ a: 1 }, ['x', 'y'])).toBe(stateKeyOf({ a: 1 }, ['y', 'x']));
  });

  it('estados diferentes tem assinaturas diferentes', () => {
    expect(stateKeyOf({ a: 1 }, ['x'])).not.toBe(stateKeyOf({ a: 2 }, ['x']));
  });
});
