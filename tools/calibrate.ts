import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from '../src/cli/args.js';
import { digest } from '../src/core/hash.js';
import { makeRng } from '../src/core/rng.js';
import {
  fitCalibration,
  saveCalibration,
  spearman,
  type LabeledSample,
} from '../src/evaluator/calibration.js';
import { createScriptedEvaluator } from '../src/evaluator/scripted.js';
import { createJevEvaluator, jevCredentialsPresent } from '../src/evaluator/jev.js';
import { withCache } from '../src/evaluator/cache.js';
import { DEFAULT_SEARCH } from '../src/search/mcts.js';
import type { Candidate, Evaluator } from '../src/evaluator/evaluator.js';
import {
  createDuelEnv,
  duelScenarios,
  greedyMove,
  initialState,
  type DuelState,
} from '../examples/duel/env.js';

/**
 * A bancada de calibracao.
 *
 * O numero publicado de 67,8% de "acuracia" do Jev e concordancia com uma
 * referencia derivada de modelo. Aqui nao: no duelo a verdade e RESOLVIDA por
 * busca exata sobre um ambiente determinista, e a nota do avaliador e comparada
 * contra ela. O que sai deste comando e uma curva de confiabilidade que os
 * portoes usam, mais tres numeros que dizem se ela merece confianca:
 * Brier, ECE e Spearman.
 *
 * Sem rodar isto, os portoes ficam no corte estrito e o relatorio avisa.
 */

interface ExactSolver {
  solve(state: DuelState): number | null;
  nodes: number;
}

function createSolver(nodeBudget: number): ExactSolver {
  const env = createDuelEnv();
  const memo = new Map<string, number>();
  const solver: ExactSolver = {
    nodes: 0,
    solve(state) {
      if (env.terminal(state)) return env.reward?.(state) ?? 0;
      const key = digest({
        a: state.agent,
        b: state.bot,
        p: state.ply,
      });
      const cached = memo.get(key);
      if (cached !== undefined) return cached;
      solver.nodes += 1;
      if (solver.nodes > nodeBudget) return null;
      let best = 0;
      for (const action of env.actions(state)) {
        const child = solver.solve(env.apply(state, action));
        if (child === null) return null;
        if (child > best) best = child;
        if (best === 1) break;
      }
      memo.set(key, best);
      return best;
    },
  };
  return solver;
}

/**
 * Amostra estados reais.
 *
 * A politica e enviesada para a jogada gulosa de proposito: ela PERDE, e sem
 * posicoes perdidas na amostra a verdade fica constante em 1 e a correlacao com
 * a cabeca de valor nao mede nada. Uma amostra sem variancia nao e uma amostra.
 */
function sampleStates(count: number, seed: string): DuelState[] {
  const env = createDuelEnv();
  const rng = makeRng(seed);
  const out: DuelState[] = [];
  const scenarios = duelScenarios(Math.max(6, Math.ceil(count / 3)));
  for (const scenario of scenarios) {
    let state = initialState(scenario);
    while (!env.terminal(state) && out.length < count) {
      out.push(state);
      const options = env.actions(state);
      if (options.length === 0) break;
      const greedy = greedyMove(state.agent);
      const fallback = options[0] as (typeof options)[number];
      const action =
        rng.next() < 0.7 ? (options.find((o) => o.key === greedy.key) ?? fallback) : rng.pick(options);
      state = env.apply(state, action);
    }
    if (out.length >= count) break;
  }
  return out.slice(0, count);
}

async function calibrateOnDuel(evaluator: Evaluator, count: number, budget: number): Promise<void> {
  const env = createDuelEnv();
  const solver = createSolver(budget);
  const states = sampleStates(count, 'calibracao');

  const screenSamples: LabeledSample[] = [];
  const trueValues: number[] = [];
  const modelValues: number[] = [];
  let skipped = 0;

  for (const state of states) {
    const truth = solver.solve(state);
    if (truth === null) {
      skipped += 1;
      continue;
    }
    const actions = env.actions(state);
    if (actions.length < 2) continue;

    // Verdade por acao: esta jogada preserva o melhor desfecho alcancavel?
    const perAction = actions.map((action) => ({
      action,
      value: solver.solve(env.apply(state, action)),
    }));
    if (perAction.some((entry) => entry.value === null)) {
      skipped += 1;
      continue;
    }
    const best = Math.max(...perAction.map((entry) => entry.value as number));

    const candidates: Candidate[] = actions.map((action) => ({
      key: action.key,
      label: action.label,
    }));
    const screened = await evaluator.screen({
      state: env.render(state),
      question: 'Esta jogada mantem o melhor desfecho alcancavel a partir deste estado?',
      candidates,
    });
    for (const entry of perAction) {
      screenSamples.push({
        p: screened.probability[entry.action.key] ?? 0.5,
        label: (entry.value as number) >= best - 1e-9,
      });
    }

    const valued = await evaluator.value({
      state: env.render(state),
      question: DEFAULT_SEARCH.valueQuestion,
      levels: DEFAULT_SEARCH.valueRubric,
    });
    trueValues.push(truth);
    modelValues.push(valued.value);
  }

  const calibration = fitCalibration(screenSamples, evaluator.id);
  const mae =
    trueValues.length > 0
      ? trueValues.reduce((sum, v, i) => sum + Math.abs(v - (modelValues[i] as number)), 0) /
        trueValues.length
      : Number.NaN;
  const rho = spearman(trueValues, modelValues);

  saveCalibration('data/calibration.json', calibration);

  process.stdout.write(
    [
      `avaliador          : ${evaluator.id}`,
      `estados amostrados : ${states.length} (${skipped} descartados por estouro de orcamento do solver)`,
      `nos do solver exato: ${solver.nodes}`,
      '',
      'cabeca de triagem (boolean) — verdade: a jogada preserva o melhor desfecho',
      `  amostras         : ${calibration.n}`,
      `  acuracia (corte 0.5): ${calibration.accuracy.toFixed(3)}`,
      `  Brier            : ${calibration.brier.toFixed(4)}  (0.25 = moeda; menor e melhor)`,
      `  ECE              : ${calibration.ece.toFixed(4)}  (distancia media entre confianca e acerto)`,
      `  faixas ajustadas : ${calibration.bins.length}`,
      '',
      'cabeca de valor (score) — verdade: valor exato do estado',
      `  pares            : ${trueValues.length}  (${new Set(trueValues).size} valores distintos na verdade)`,
      `  Spearman         : ${
        Number.isNaN(rho) ? 'n/a — a verdade nao varia na amostra; aumente --states' : rho.toFixed(3)
      }`,
      `  MAE              : ${Number.isNaN(mae) ? 'n/a' : mae.toFixed(3)}`,
      '',
      'curva gravada em data/calibration.json — a partir daqui os portoes usam',
      'a confianca calibrada, e o relatorio para de avisar que ela nao foi aferida.',
      '',
      'Leia o Brier antes de afrouxar qualquer corte: uma curva ajustada sobre um',
      'avaliador ruim continua sendo um avaliador ruim, so que melhor descrito.',
    ].join('\n') + '\n',
  );
}

interface FileSample {
  readonly state: unknown;
  readonly question: string;
  readonly candidates: readonly Candidate[];
  readonly labels: Readonly<Record<string, boolean>>;
}

async function calibrateOnFile(evaluator: Evaluator, path: string): Promise<void> {
  if (!existsSync(path)) {
    process.stderr.write(`arquivo de amostras inexistente: ${path}\n`);
    process.exit(2);
  }
  const rows = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FileSample);

  const samples: LabeledSample[] = [];
  for (const row of rows) {
    const screened = await evaluator.screen({
      state: row.state as string,
      question: row.question,
      candidates: row.candidates,
    });
    for (const candidate of row.candidates) {
      const label = row.labels[candidate.key];
      if (label === undefined) continue;
      samples.push({ p: screened.probability[candidate.key] ?? 0.5, label });
    }
  }

  const calibration = fitCalibration(samples, evaluator.id);
  saveCalibration('data/calibration.json', calibration);
  process.stdout.write(
    [
      `avaliador : ${evaluator.id}`,
      `amostras  : ${calibration.n} rotulos de ${rows.length} estados`,
      `acuracia  : ${calibration.accuracy.toFixed(3)}`,
      `Brier     : ${calibration.brier.toFixed(4)}`,
      `ECE       : ${calibration.ece.toFixed(4)}`,
      'curva gravada em data/calibration.json',
    ].join('\n') + '\n',
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const kind = args.str('evaluator', jevCredentialsPresent() ? 'jev' : 'scripted');

  let evaluator: Evaluator;
  if (kind === 'jev') {
    if (!jevCredentialsPresent()) {
      process.stderr.write('sem AI_GATEWAY_API_KEY nem TYPESAFE_AI_API_KEY\n');
      process.exit(2);
    }
    evaluator = withCache(createJevEvaluator({ seed: 'calibracao', debiasPasses: 2 }));
  } else {
    // Substituto offline: prefere dano bruto, que e uma heuristica plausivel e
    // errada. Serve para provar que a bancada DETECTA um avaliador ruim.
    evaluator = createScriptedEvaluator({
      id: 'scripted:dano',
      heuristic: {
        candidate(_state, label) {
          const match = /(\d+) de dano/.exec(label);
          return Math.min(1, (match ? Number(match[1]) : 0) / 30);
        },
        state(state) {
          const data = state as { agente?: { vida: number; max: number }; oponente?: { vida: number; max: number } };
          const a = data.agente ? data.agente.vida / data.agente.max : 0.5;
          const b = data.oponente ? data.oponente.vida / data.oponente.max : 0.5;
          return Math.min(1, Math.max(0, 0.5 + (a - b) / 2));
        },
      },
    });
  }

  const file = args.options.get('samples');
  if (file) {
    await calibrateOnFile(evaluator, file);
    return;
  }
  await calibrateOnDuel(evaluator, args.num('states', 40), args.num('solver-budget', 400_000));
}

await main();
