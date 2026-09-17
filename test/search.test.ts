import { describe, expect, it } from 'vitest';
import { DEFAULT_SEARCH, search } from '../src/search/mcts.js';
import { createScriptedEvaluator } from '../src/evaluator/scripted.js';
import { rollout, type Environment } from '../src/env/environment.js';
import { makeRng } from '../src/core/rng.js';
import {
  createDuelEnv,
  duelScenarios,
  initialState,
  playGreedy,
  type DuelScenario,
  type DuelState,
} from '../examples/duel/env.js';
import { createDevTaskEnv, initialState as devTaskInitial } from '../examples/devtask/env.js';

const evaluator = () => createScriptedEvaluator({ id: 'uniform' });

const searchConfig = {
  ...DEFAULT_SEARCH,
  iterations: 200,
  screenThreshold: null,
  maxDepth: 60,
  rolloutDepth: 80,
  budget: { calls: 5000, wallMs: 20_000 },
};

async function playWithSearch(scenario: DuelScenario, seed: string): Promise<DuelState> {
  const env = createDuelEnv();
  let state = initialState(scenario);
  let turn = 0;
  while (!env.terminal(state)) {
    const outcome = await search(state, {
      env,
      evaluator: evaluator(),
      config: { ...searchConfig, seed: `${seed}:${turn}` },
    });
    if (!outcome.decision) break;
    state = env.apply(state, outcome.decision.action);
    turn += 1;
  }
  return state;
}

/** Posicao em que o guloso perde: o oponente aguenta mais golpes do que ele tem turnos. */
const HARD: DuelScenario = { id: 'dificil', agentHp: 100, botHp: 130, plyCap: 60 };

describe('mcts em ambiente grounded', () => {
  it('vence a partida que a heuristica de 1 ply perde', async () => {
    expect(playGreedy(HARD).won).toBe(false);
    const final = await playWithSearch(HARD, 'teste');
    expect(final.bot.hp).toBeLessThanOrEqual(0);
    expect(final.agent.hp).toBeGreaterThan(0);
  });

  it('o guloso ainda ganha onde ganhar e facil — o ganho nao vem de graca', () => {
    const easy = duelScenarios(1)[0] as DuelScenario;
    expect(playGreedy(easy).won).toBe(true);
  });

  it('o valor da folha vem do ambiente, nao do avaliador', async () => {
    const scenario = duelScenarios(1)[0] as DuelScenario;
    const outcome = await search(initialState(scenario), {
      env: createDuelEnv(),
      evaluator: evaluator(),
      config: { ...searchConfig, seed: 'v' },
    });
    expect(outcome.decision?.valueSource).toBe('grounded-rollout');
    expect(outcome.decision?.speculative).toBe(false);
    expect(outcome.decision?.groundedFraction).toBe(1);
    expect(outcome.decision?.valueSources['jev-score']).toBe(0);
  });

  it('a mesma semente devolve a mesma decisao', async () => {
    const scenario = duelScenarios(1)[0] as DuelScenario;
    const run = () =>
      search(initialState(scenario), {
        env: createDuelEnv(),
        evaluator: evaluator(),
        config: { ...searchConfig, seed: 'estavel' },
      });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.decision?.action.key).toBe(b.decision?.action.key);
    expect(a.decision?.visits).toBe(b.decision?.visits);
    expect(a.decision?.meanValue).toBeCloseTo(b.decision?.meanValue ?? -1, 12);
  });

  it('o resultado nao depende da semente: toda semente vence a posicao dificil', async () => {
    // A jogada exata pode variar (ha mais de uma linha vencedora); o DESFECHO nao.
    const finals = await Promise.all(['s1', 's2', 's3'].map((seed) => playWithSearch(HARD, seed)));
    for (const final of finals) {
      expect(final.bot.hp).toBeLessThanOrEqual(0);
      expect(final.agent.hp).toBeGreaterThan(0);
    }
  });

  it('o orcamento interrompe a busca e o motivo aparece nas estatisticas', async () => {
    const scenario = duelScenarios(1)[0] as DuelScenario;
    const outcome = await search(initialState(scenario), {
      env: createDuelEnv(),
      evaluator: evaluator(),
      config: { ...searchConfig, iterations: 10_000, budget: { calls: 3 } },
    });
    expect(outcome.stats.stoppedBy).toBe('calls');
    expect(outcome.stats.iterations).toBeLessThan(10_000);
    expect(outcome.decision).not.toBeNull();
  });
});

/**
 * Cadeia linear grounded onde so o fim tem recompensa. Com `rolloutDepth: 0` o
 * playout nao chega ao fim, entao as folhas nao-terminais caem no avaliador e as
 * terminais nao: uma busca genuinamente MISTA.
 */
function chainEnv(): Environment<number> {
  return {
    name: 'cadeia',
    fidelity: 'grounded',
    actions: (n) => (n >= 4 ? [] : [
      { key: 'passo', label: 'avanca 1', risk: 'safe' },
      { key: 'pulo', label: 'avanca 2', risk: 'safe' },
    ]),
    apply: (n, action) => n + (action.key === 'pulo' ? 2 : 1),
    terminal: (n) => n >= 4,
    reward: (n) => (n >= 4 ? 1 : undefined),
    render: (n) => ({ n }),
  };
}

describe('procedencia do valor', () => {
  it('conta folha a folha: uma folha medida nao carimba a busca inteira', async () => {
    const outcome = await search(0, {
      env: chainEnv(),
      evaluator: createScriptedEvaluator({ id: 'plano' }),
      config: {
        ...DEFAULT_SEARCH,
        iterations: 120,
        screenThreshold: null,
        maxDepth: 4,
        rolloutDepth: 0,
        seed: 'mista',
      },
    });
    const sources = outcome.decision?.valueSources;
    expect(sources?.['grounded-reward']).toBeGreaterThan(0);
    expect(sources?.['jev-score']).toBeGreaterThan(0);
    const fraction = outcome.decision?.groundedFraction ?? -1;
    expect(fraction).toBeGreaterThan(0);
    expect(fraction).toBeLessThan(1);
  });

  it('a soma das procedencias bate com as iteracoes realizadas', async () => {
    const outcome = await search(0, {
      env: chainEnv(),
      evaluator: createScriptedEvaluator({ id: 'plano' }),
      config: { ...DEFAULT_SEARCH, iterations: 50, screenThreshold: null, maxDepth: 4, rolloutDepth: 0 },
    });
    const total = Object.values(outcome.decision?.valueSources ?? {}).reduce((a, b) => a + b, 0);
    expect(total).toBe(outcome.stats.iterations);
  });
});

describe('mcts em ambiente speculative', () => {
  it('a profundidade e recortada e a decisao sai marcada', async () => {
    const outcome = await search(devTaskInitial('publicar a correcao'), {
      env: createDevTaskEnv(),
      evaluator: createScriptedEvaluator({ id: 'plano' }),
      config: { ...DEFAULT_SEARCH, iterations: 60, maxDepth: 30, speculativeMaxDepth: 2 },
    });
    expect(outcome.stats.depthCap).toBe(2);
    expect(outcome.stats.depthCapClamped).toBe(true);
    expect(outcome.decision?.speculative).toBe(true);
    expect(outcome.decision?.valueSource).toBe('jev-score');
  });

  it('rollout se recusa a rodar sobre transicao inventada', () => {
    expect(() =>
      rollout(createDevTaskEnv(), devTaskInitial('x'), makeRng(1), 5),
    ).toThrow(/speculative/);
  });
});
