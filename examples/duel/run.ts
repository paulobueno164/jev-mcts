import { parseArgs } from '../../src/cli/args.js';
import { DEFAULT_SEARCH, search } from '../../src/search/mcts.js';
import { createScriptedEvaluator } from '../../src/evaluator/scripted.js';
import { createJevEvaluator, jevCredentialsPresent } from '../../src/evaluator/jev.js';
import { withCache, type CachingEvaluator } from '../../src/evaluator/cache.js';
import type { Evaluator } from '../../src/evaluator/evaluator.js';
import {
  createDuelEnv,
  duelScenarios,
  initialState,
  playGreedy,
  type DuelScenario,
} from './env.js';

/**
 * A bancada.
 *
 * Nao existe para mostrar que a arvore "funciona": existe para produzir numeros
 * comparaveis na MESMA lista de cenarios, com verdade conhecida.
 *   1. guloso             -- nenhuma busca, a heuristica de 1 ply
 *   2. mcts + prior plano -- a busca sozinha, sem nenhum modelo
 *   3. mcts + prior       -- a busca com o prior do avaliador
 * A diferenca entre 2 e 3 e exatamente quanto o prior vale AQUI, medido, e nao
 * citado de um benchmark de terceiro.
 */

/** Latencia publicada do Jev por chamada. E o custo que nao aparece em dolares. */
const JEV_LATENCY_S = 0.114;

interface GameResult {
  readonly won: boolean;
  readonly reward: number;
  readonly plies: number;
  readonly calls: number;
  readonly usd: number;
}

interface ArmResult {
  readonly name: string;
  readonly wins: number;
  readonly games: number;
  readonly meanReward: number;
  readonly meanPlies: number;
  readonly calls: number;
  readonly cacheHits: number;
  readonly usd: number;
  readonly ms: number;
}

const flatEvaluator = (): Evaluator => createScriptedEvaluator({ id: 'uniform' });

/** Prior "plausivel": prefere dano bruto. E o que um classificador diria lendo os rotulos. */
const damagePriorEvaluator = (): Evaluator =>
  createScriptedEvaluator({
    id: 'scripted:dano',
    heuristic: {
      candidate(_state, label) {
        const match = /(\d+) de dano/.exec(label);
        const damage = match ? Number(match[1]) : 0;
        return Math.min(1, damage / 30);
      },
    },
  });

async function playSearch(
  scenario: DuelScenario,
  evaluator: Evaluator,
  iterations: number,
): Promise<GameResult> {
  const env = createDuelEnv();
  let state = initialState(scenario);
  let calls = 0;
  let usd = 0;
  let turn = 0;

  while (!env.terminal(state)) {
    const outcome = await search(state, {
      env,
      evaluator,
      config: {
        ...DEFAULT_SEARCH,
        iterations,
        // Duelo e grounded: o valor da folha vem do playout real, nunca do Jev.
        // A triagem fica desligada de proposito para isolar o efeito do prior.
        screenThreshold: null,
        maxDepth: 60,
        rolloutDepth: 80,
        seed: `${scenario.id}:${turn}`,
        budget: { calls: 5000, wallMs: 30_000 },
      },
    });
    calls += outcome.stats.evaluatorCalls;
    usd += outcome.stats.budget.usd;
    if (!outcome.decision) break;
    state = env.apply(state, outcome.decision.action);
    turn += 1;
  }

  return {
    won: state.bot.hp <= 0 && state.agent.hp > 0,
    reward: env.reward?.(state) ?? 0,
    plies: state.ply,
    calls,
    usd,
  };
}

async function runArm(
  name: string,
  scenarios: readonly DuelScenario[],
  play: (scenario: DuelScenario) => Promise<GameResult>,
  cache?: CachingEvaluator,
): Promise<ArmResult> {
  const startedAt = Date.now();
  let wins = 0;
  let reward = 0;
  let plies = 0;
  let calls = 0;
  let usd = 0;
  for (const scenario of scenarios) {
    const result = await play(scenario);
    if (result.won) wins += 1;
    reward += result.reward;
    plies += result.plies;
    calls += result.calls;
    usd += result.usd;
  }
  return {
    name,
    wins,
    games: scenarios.length,
    meanReward: reward / scenarios.length,
    meanPlies: plies / scenarios.length,
    calls,
    cacheHits: cache?.stats.hits ?? 0,
    usd,
    ms: Date.now() - startedAt,
  };
}

function table(arms: readonly ArmResult[]): string {
  const cols: [string, number][] = [
    ['arm', -34],
    ['vitorias', 10],
    ['recompensa', 12],
    ['turnos', 9],
    ['chamadas', 10],
    ['cache', 8],
    ['US$', 11],
    ['lat@114ms', 11],
    ['ms', 8],
  ];
  const pad = (text: string, width: number): string =>
    width < 0 ? text.padEnd(-width) : text.padStart(width);
  const header = cols.map(([label, width]) => pad(label, width)).join('');
  const rows = arms.map((arm) =>
    [
      pad(arm.name, -34),
      pad(`${arm.wins}/${arm.games}`, 10),
      pad(arm.meanReward.toFixed(3), 12),
      pad(arm.meanPlies.toFixed(1), 9),
      pad(String(arm.calls), 10),
      pad(String(arm.cacheHits), 8),
      pad(arm.usd.toFixed(6), 11),
      pad(`${(arm.calls * JEV_LATENCY_S).toFixed(1)}s`, 11),
      pad(String(arm.ms), 8),
    ].join(''),
  );
  return [header, '-'.repeat(header.length), ...rows].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const count = args.num('scenarios', 24);
  const iterations = args.num('iterations', 300);
  const kind = args.str('evaluator', 'scripted');
  const scenarios = duelScenarios(count);

  let inner: Evaluator;
  if (kind === 'jev') {
    if (!jevCredentialsPresent()) {
      process.stderr.write('sem AI_GATEWAY_API_KEY nem TYPESAFE_AI_API_KEY; use --evaluator scripted\n');
      process.exit(2);
    }
    inner = createJevEvaluator({ seed: 'duel' });
  } else {
    inner = damagePriorEvaluator();
  }

  // Os dois bracos com busca usam cache. Sem ele a coluna "chamadas" mede o
  // tamanho da arvore, e nao o custo de rodar isso contra uma API de verdade.
  const flatCache = withCache(flatEvaluator());
  const priorCache = withCache(inner);

  const arms: ArmResult[] = [
    await runArm('guloso (1 ply, sem busca)', scenarios, async (scenario) => ({
      ...playGreedy(scenario),
      calls: 0,
      usd: 0,
    })),
    await runArm(
      `mcts prior plano (${iterations} it)`,
      scenarios,
      (scenario) => playSearch(scenario, flatCache, iterations),
      flatCache,
    ),
    await runArm(
      `mcts prior ${kind} (${iterations} it)`,
      scenarios,
      (scenario) => playSearch(scenario, priorCache, iterations),
      priorCache,
    ),
  ];

  if (args.has('json')) {
    process.stdout.write(`${JSON.stringify({ scenarios: scenarios.length, iterations, arms }, null, 2)}\n`);
  } else {
    process.stdout.write(`${table(arms)}\n`);
    process.stdout.write(
      '\nA diferenca entre as duas ultimas linhas e o que o prior do avaliador vale aqui.\n' +
        'O valor da folha veio de playout real em todas as linhas: nenhum numero acima e estimativa.\n' +
        'lat@114ms projeta a latencia se essas chamadas fossem ao Jev, em serie. E ela, nao o\n' +
        'dolar, que decide se a arvore cabe dentro de um laco de trabalho.\n',
    );
  }

  if (args.has('check')) {
    const greedy = arms[0] as ArmResult;
    const flat = arms[1] as ArmResult;
    if (flat.wins <= greedy.wins) {
      process.stderr.write(
        `FALHOU: mcts venceu ${flat.wins}/${flat.games} contra ${greedy.wins}/${greedy.games} do guloso\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`OK: mcts ${flat.wins}/${flat.games} > guloso ${greedy.wins}/${greedy.games}\n`);
  }
}

await main();
