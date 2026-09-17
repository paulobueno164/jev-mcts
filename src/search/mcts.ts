import type { Action, Decision, ValueSource } from '../core/types.js';
import { makeRng, strHash, type Rng } from '../core/rng.js';
import { Budget, type BudgetBreach, type BudgetLimits, type BudgetSnapshot } from '../core/budget.js';
import { digest } from '../core/hash.js';
import type { Journal } from '../core/journal.js';
import { rollout, type Environment } from '../env/environment.js';
import type { Evaluator } from '../evaluator/evaluator.js';
import { calibrate, identityCalibration, type Calibration } from '../evaluator/calibration.js';

export interface SearchConfig {
  readonly iterations: number;
  /** Constante de exploracao do PUCT. 1.4 e o default classico. */
  readonly cPuct: number;
  /** Profundidade maxima em ambiente grounded. */
  readonly maxDepth: number;
  /**
   * Teto DURO em ambiente speculative. Cada nivel a mais compoe o erro do
   * modelo de transicao em vez de reduzi-lo, entao ele nao e negociavel em
   * runtime: valores maiores sao recortados e a corrida registra o recorte.
   */
  readonly speculativeMaxDepth: number;
  readonly rolloutDepth: number;
  /** Alargamento progressivo: filhos permitidos = ceil(k * N^alpha). null = todos. */
  readonly widening: { readonly k: number; readonly alpha: number } | null;
  /** Corte de triagem sobre a confianca CALIBRADA. null desliga a triagem. */
  readonly screenThreshold: number | null;
  readonly screenQuestion: string;
  readonly priorQuestion: string;
  readonly valueQuestion: string;
  /** Niveis da rubrica de valor, do pior para o melhor. */
  readonly valueRubric: readonly string[];
  readonly fpuReduction: number;
  readonly seed: number | string;
  readonly budget: BudgetLimits;
  /** Prior forcado por decisao humana anterior, por chave de acao. */
  readonly priorOverride?: Readonly<Record<string, number>>;
  /**
   * Acoes que um humano recusou NESTE estado. Sao removidas da raiz, nao apenas
   * despriorizadas: um "nao" nao e um prior baixo que a busca pode reverter
   * sozinha depois de algumas visitas.
   */
  readonly bannedAtRoot?: readonly string[];
}

export const DEFAULT_SEARCH: SearchConfig = Object.freeze({
  iterations: 200,
  cPuct: 1.4,
  maxDepth: 24,
  speculativeMaxDepth: 2,
  rolloutDepth: 40,
  widening: { k: 2, alpha: 0.5 },
  screenThreshold: 0.35,
  screenQuestion: 'Esta acao e um proximo passo valido e util para o objetivo declarado?',
  priorQuestion: 'Qual destas acoes e o melhor proximo passo para o objetivo declarado?',
  valueQuestion: 'Quao perto do objetivo este estado esta?',
  valueRubric: Object.freeze([
    'Longe do objetivo ou em caminho errado',
    'Algum progresso, muito por fazer',
    'Progresso claro, faltam poucos passos',
    'Objetivo praticamente alcancado',
  ]),
  fpuReduction: 0.25,
  seed: 1,
  budget: { calls: 400, wallMs: 120_000 },
});

interface Child<S> {
  readonly action: Action;
  prior: number;
  visits: number;
  valueSum: number;
  node: Node<S> | null;
  /** Confianca calibrada de que a acao e valida. undefined = sem triagem. */
  screened: number | undefined;
  /**
   * Desempate determinista, derivado da chave da acao uma unica vez na
   * expansao. Fica aqui em vez de ser recalculado no laco de selecao: aquele
   * laco roda por filho, por iteracao, e nao e lugar de hash criptografico.
   */
  readonly tieBreak: number;
}

interface Node<S> {
  readonly state: S;
  readonly depth: number;
  visits: number;
  valueSum: number;
  expanded: boolean;
  terminal: boolean;
  children: Child<S>[];
}

export interface SearchStats {
  readonly iterations: number;
  readonly nodes: number;
  readonly evaluatorCalls: number;
  readonly budget: BudgetSnapshot;
  readonly stoppedBy: BudgetBreach | 'iterations' | 'no-actions';
  readonly depthCap: number;
  readonly depthCapClamped: boolean;
  readonly calibrated: boolean;
  readonly prunedByScreen: number;
}

export interface SearchOutcome<S> {
  readonly decision: Decision | null;
  readonly stats: SearchStats;
  readonly rootChildren: ReadonlyArray<{ action: Action; prior: number; visits: number; mean: number }>;
  readonly nextState: S | null;
}

export interface SearchDeps<S> {
  readonly env: Environment<S>;
  readonly evaluator: Evaluator;
  readonly config: SearchConfig;
  readonly calibration?: Calibration;
  readonly journal?: Journal;
}

/**
 * MCTS com PUCT, First-Play Urgency e alargamento progressivo.
 *
 * O que o separa de uma arvore sobre LLM: o proximo estado vem SEMPRE de
 * `env.apply`, e o valor da folha vem do ambiente quando o ambiente sabe medir.
 * O avaliador so entra em tres lugares -- triagem, prior e valor de folha sem
 * recompensa -- e cada um deles fica registrado com a sua procedencia.
 */
export async function search<S>(root: S, deps: SearchDeps<S>): Promise<SearchOutcome<S>> {
  const { env, evaluator, config, journal } = deps;
  const calibration = deps.calibration ?? identityCalibration(evaluator.id);
  const budget = new Budget(config.budget);
  const rng = makeRng(config.seed);

  const requestedCap = config.maxDepth;
  const depthCap =
    env.fidelity === 'speculative'
      ? Math.min(requestedCap, config.speculativeMaxDepth)
      : requestedCap;
  const depthCapClamped = depthCap < requestedCap;

  const rootNode: Node<S> = {
    state: root,
    depth: 0,
    visits: 0,
    valueSum: 0,
    expanded: false,
    terminal: env.terminal(root),
    children: [],
  };

  let nodes = 1;
  let evaluatorCalls = 0;
  let prunedByScreen = 0;
  let stoppedBy: SearchStats['stoppedBy'] = 'iterations';
  let iterations = 0;
  /**
   * Procedencia POR FOLHA. Um rotulo unico para a busca inteira deixaria uma
   * unica folha terminal com recompensa carimbar "medido" numa decisao em que
   * quase todo o valor foi estimativa.
   */
  const valueSources: Record<ValueSource, number> = {
    'grounded-reward': 0,
    'grounded-rollout': 0,
    'jev-score': 0,
    'prior-only': 0,
  };

  const note = (calls: number, usage: { inputTokens: number; outputTokens: number }) => {
    evaluatorCalls += calls;
    // calls === 0 e acerto de cache: nao custa chamada, token nem dinheiro, e
    // portanto nao pode consumir orcamento.
    for (let i = 0; i < calls; i++) budget.record(i === 0 ? usage : {});
  };

  const expand = async (node: Node<S>): Promise<void> => {
    const legal = env.actions(node.state);
    if (legal.length === 0) {
      node.expanded = true;
      node.terminal = true;
      return;
    }
    const candidates = legal.map((action) => ({ key: action.key, label: action.label }));
    const stateView = env.render(node.state);

    let screened: Record<string, number> | undefined;
    if (config.screenThreshold !== null && legal.length > 1) {
      const result = await evaluator.screen({
        state: stateView,
        question: config.screenQuestion,
        candidates,
      });
      note(result.calls, result.usage);
      journal?.write('eval.call', {
        method: 'screen',
        node: digest(stateView),
        candidates: candidates.length,
        calls: result.calls,
        inputTokens: result.usage.inputTokens,
      });
      screened = {};
      for (const candidate of candidates) {
        screened[candidate.key] = calibrate(calibration, result.probability[candidate.key] ?? 0.5);
      }
    }

    let survivors = legal;
    if (screened && config.screenThreshold !== null) {
      const kept = legal.filter((a) => (screened?.[a.key] ?? 1) >= (config.screenThreshold as number));
      if (kept.length > 0) {
        prunedByScreen += legal.length - kept.length;
        survivors = kept;
      }
      // Se a triagem reprovou tudo, nao se joga o estado fora: mantem-se o legal
      // inteiro e o portao humano decide depois. Nunca ha "nenhuma opcao".
    }

    if (node.depth === 0 && config.bannedAtRoot && config.bannedAtRoot.length > 0) {
      const banned = new Set(config.bannedAtRoot);
      const kept = survivors.filter((a) => !banned.has(a.key));
      // Se o humano recusou tudo o que havia, nao se inventa uma saida: a busca
      // devolve o leque cheio e o portao escala de novo.
      if (kept.length > 0) survivors = kept;
    }

    let distribution: Record<string, number>;
    if (survivors.length === 1) {
      distribution = { [(survivors[0] as Action).key]: 1 };
    } else {
      const result = await evaluator.priors({
        state: stateView,
        question: config.priorQuestion,
        candidates: survivors.map((a) => ({ key: a.key, label: a.label })),
      });
      note(result.calls, result.usage);
      journal?.write('eval.call', {
        method: 'priors',
        node: digest(stateView),
        candidates: survivors.length,
        calls: result.calls,
        inputTokens: result.usage.inputTokens,
      });
      distribution = { ...result.distribution };
    }

    if (node.depth === 0 && config.priorOverride) {
      // Uma decisao humana anterior sobre este mesmo estado vale mais que o
      // prior do modelo: entra como prior duro, e a busca so o revisa com
      // evidencia de rollout.
      for (const [key, weight] of Object.entries(config.priorOverride)) {
        if (key in distribution) distribution[key] = weight;
      }
      const total = Object.values(distribution).reduce((a, b) => a + b, 0) || 1;
      for (const key of Object.keys(distribution)) {
        distribution[key] = (distribution[key] as number) / total;
      }
    }

    node.children = survivors
      .map((action) => ({
        action,
        prior: distribution[action.key] ?? 1 / survivors.length,
        visits: 0,
        valueSum: 0,
        node: null,
        screened: screened?.[action.key],
        tieBreak: (strHash(action.key) / 4294967296) * 1e-9,
      }))
      .sort((a, b) => b.prior - a.prior);
    node.expanded = true;
  };

  const leafValue = async (node: Node<S>, playoutRng: Rng): Promise<number> => {
    const direct = env.reward?.(node.state);
    if (direct !== undefined) {
      valueSources['grounded-reward'] += 1;
      return Math.min(1, Math.max(0, direct));
    }
    if (env.fidelity === 'grounded') {
      const played = rollout(env, node.state, playoutRng, config.rolloutDepth);
      if (played.reward !== undefined) {
        valueSources['grounded-rollout'] += 1;
        return Math.min(1, Math.max(0, played.reward));
      }
    }
    const result = await evaluator.value({
      state: env.render(node.state),
      question: config.valueQuestion,
      levels: config.valueRubric,
    });
    note(result.calls, result.usage);
    journal?.write('eval.call', {
      method: 'value',
      node: digest(env.render(node.state)),
      raw: result.raw,
      calls: result.calls,
      inputTokens: result.usage.inputTokens,
    });
    valueSources['jev-score'] += 1;
    return result.value;
  };

  const selectChild = (node: Node<S>): Child<S> | null => {
    if (node.children.length === 0) return null;
    const allowed = config.widening
      ? Math.min(
          node.children.length,
          Math.max(1, Math.ceil(config.widening.k * Math.pow(Math.max(1, node.visits), config.widening.alpha))),
        )
      : node.children.length;
    const pool = node.children.slice(0, allowed);
    const parentMean = node.visits > 0 ? node.valueSum / node.visits : 0.5;
    let visitedPriorMass = 0;
    for (const child of pool) if (child.visits > 0) visitedPriorMass += child.prior;
    const fpu = parentMean - config.fpuReduction * Math.sqrt(visitedPriorMass);
    const sqrtTotal = Math.sqrt(Math.max(1, node.visits));

    let best: Child<S> | null = null;
    let bestScore = -Infinity;
    for (const child of pool) {
      const q = child.visits > 0 ? child.valueSum / child.visits : fpu;
      const u = config.cPuct * child.prior * (sqrtTotal / (1 + child.visits));
      // Desempate determinista, pre-computado: sem Math.random na busca.
      const score = q + u + child.tieBreak;
      if (score > bestScore) {
        bestScore = score;
        best = child;
      }
    }
    return best;
  };

  for (let i = 0; i < config.iterations; i++) {
    const breach = budget.exceeded();
    if (breach) {
      stoppedBy = breach;
      journal?.write('budget.breach', { breach, at: i, snapshot: budget.snapshot() as never });
      break;
    }
    iterations = i + 1;

    const path: { node: Node<S>; child: Child<S> | null }[] = [];
    let node = rootNode;

    for (;;) {
      if (node.terminal || node.depth >= depthCap) break;
      if (!node.expanded) {
        await expand(node);
        if (node.children.length === 0) break;
      }
      const child = selectChild(node);
      if (!child) break;
      path.push({ node, child });
      if (!child.node) {
        const nextState = env.apply(node.state, child.action);
        child.node = {
          state: nextState,
          depth: node.depth + 1,
          visits: 0,
          valueSum: 0,
          expanded: false,
          terminal: env.terminal(nextState),
          children: [],
        };
        nodes++;
        node = child.node;
        break;
      }
      node = child.node;
    }

    if (rootNode.children.length === 0 && rootNode.expanded) {
      stoppedBy = 'no-actions';
      break;
    }

    const value = await leafValue(node, rng.fork('rollout:' + String(i)));

    node.visits += 1;
    node.valueSum += value;
    for (const step of path) {
      step.node.visits += 1;
      step.node.valueSum += value;
      if (step.child) {
        step.child.visits += 1;
        step.child.valueSum += value;
      }
    }
  }

  const ranked = rootNode.children
    .map((child) => ({
      action: child.action,
      prior: child.prior,
      visits: child.visits,
      mean: child.visits > 0 ? child.valueSum / child.visits : 0,
      screened: child.screened,
    }))
    .sort((a, b) => b.visits - a.visits || b.mean - a.mean);

  const stats: SearchStats = {
    iterations,
    nodes,
    evaluatorCalls,
    budget: budget.snapshot(),
    stoppedBy,
    depthCap,
    depthCapClamped,
    calibrated: calibration.fitted,
    prunedByScreen,
  };

  const top = ranked[0];
  if (!top) {
    return { decision: null, stats, rootChildren: [], nextState: null };
  }
  const second = ranked[1];
  const totalVisits = ranked.reduce((sum, r) => sum + r.visits, 0) || 1;
  const margin = (top.visits - (second?.visits ?? 0)) / totalVisits;

  const leafTotal = Object.values(valueSources).reduce((sum, n) => sum + n, 0);
  const groundedLeaves = valueSources['grounded-reward'] + valueSources['grounded-rollout'];
  const groundedFraction = leafTotal > 0 ? groundedLeaves / leafTotal : 0;
  const dominant = (Object.entries(valueSources) as [ValueSource, number][]).reduce(
    (best, entry) => (entry[1] > best[1] ? entry : best),
    ['prior-only', -1] as [ValueSource, number],
  )[0];

  const decision: Decision = {
    action: top.action,
    visits: top.visits,
    meanValue: top.mean,
    margin,
    valueSource: dominant,
    valueSources: { ...valueSources },
    groundedFraction,
    ...(top.screened !== undefined ? { confidence: top.screened } : {}),
    speculative: env.fidelity === 'speculative',
    ranking: ranked.map((r) => ({
      key: r.action.key,
      label: r.action.label,
      visits: r.visits,
      meanValue: r.mean,
      prior: r.prior,
    })),
  };

  journal?.write('search.done', {
    action: decision.action.key,
    visits: decision.visits,
    meanValue: decision.meanValue,
    margin: decision.margin,
    valueSource: decision.valueSource,
    valueSources: decision.valueSources,
    groundedFraction: decision.groundedFraction,
    speculative: decision.speculative,
    stoppedBy: stats.stoppedBy,
    evaluatorCalls: stats.evaluatorCalls,
    usd: stats.budget.usd,
  });

  return {
    decision,
    stats,
    rootChildren: ranked.map((r) => ({
      action: r.action,
      prior: r.prior,
      visits: r.visits,
      mean: r.mean,
    })),
    nextState: env.apply(rootNode.state, top.action),
  };
}
