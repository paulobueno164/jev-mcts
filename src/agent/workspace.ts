import type { Action, Json, RiskClass } from '../core/types.js';
import { RISK_ORDER } from '../core/types.js';
import type { Journal } from '../core/journal.js';
import type { Environment } from '../env/environment.js';
import type { Executor } from '../orchestration/orchestrator.js';
import { observeProbes, type Probe, type ProbeResult } from './probe.js';
import type { AgentRun, AgentRunner } from './runner.js';

// ---------------------------------------------------------------------------
// Especificacao da tarefa
// ---------------------------------------------------------------------------

export interface WorkspaceStepSpec {
  readonly key: string;
  readonly label: string;
  readonly risk: RiskClass;
  /** Marcos que precisam existir antes. Aqui isso e filtro duro, nao dica. */
  readonly requires?: readonly string[];
  /** Marco concedido SE as sondas de `verify` ficarem verdes. */
  readonly yields: string;
  /** Sondas que decidem se o marco foi conquistado. Vazio = so o codigo do agente. */
  readonly verify?: readonly string[];
  /** O que dizer ao agente. Sem prompt, o passo apenas roda as sondas. */
  readonly prompt?: string;
  readonly timeoutMs?: number;
}

export interface WorkspaceSpec {
  readonly name: string;
  readonly goal: string;
  readonly cwd?: string;
  readonly probes: readonly Probe[];
  readonly steps: readonly WorkspaceStepSpec[];
  /** Marcos que precisam existir para a tarefa acabar. */
  readonly goalMilestones: readonly string[];
  /** Sondas que precisam estar verdes para a tarefa acabar. */
  readonly goalProbes?: readonly string[];
  /** Teto de tempo de EXECUCAO da sessao inteira, somando agente e sondas. */
  readonly budgetMs?: number;
  readonly stepCap?: number;
  /** Quantas vezes um passo pode ser tentado antes de sair do leque. Default 2. */
  readonly maxAttemptsPerStep?: number;
}

const RISKS = new Set(Object.keys(RISK_ORDER));

function fail(message: string): never {
  throw new Error(`spec invalida: ${message}`);
}

/** Uma spec e entrada do usuario. Erra cedo e com o nome do campo. */
export function parseWorkspaceSpec(raw: unknown): WorkspaceSpec {
  const spec = raw as Partial<WorkspaceSpec>;
  if (!spec || typeof spec !== 'object') fail('raiz nao e um objeto');
  if (!spec.name) fail('campo "name" ausente');
  if (!spec.goal) fail('campo "goal" ausente');
  if (!Array.isArray(spec.probes)) fail('campo "probes" precisa ser uma lista');
  if (!Array.isArray(spec.steps) || spec.steps.length === 0) fail('campo "steps" vazio');
  if (!Array.isArray(spec.goalMilestones) || spec.goalMilestones.length === 0) {
    fail('campo "goalMilestones" vazio — sem ele a tarefa nao sabe terminar');
  }

  const probeIds = new Set<string>();
  for (const probe of spec.probes) {
    if (!probe.id) fail('sonda sem "id"');
    if (probeIds.has(probe.id)) fail(`sonda duplicada: ${probe.id}`);
    if (!probe.command) fail(`sonda "${probe.id}" sem "command"`);
    probeIds.add(probe.id);
  }

  const stepKeys = new Set<string>();
  const yielded = new Set<string>();
  for (const step of spec.steps) {
    if (!step.key) fail('passo sem "key"');
    if (stepKeys.has(step.key)) fail(`passo duplicado: ${step.key}`);
    if (!step.label) fail(`passo "${step.key}" sem "label"`);
    if (!step.yields) fail(`passo "${step.key}" sem "yields"`);
    if (!RISKS.has(step.risk)) {
      fail(`passo "${step.key}" com risco "${String(step.risk)}" fora de ${[...RISKS].join('|')}`);
    }
    for (const id of step.verify ?? []) {
      if (!probeIds.has(id)) fail(`passo "${step.key}" verifica sonda inexistente: ${id}`);
    }
    stepKeys.add(step.key);
    yielded.add(step.yields);
  }
  for (const step of spec.steps) {
    for (const need of step.requires ?? []) {
      if (!yielded.has(need)) {
        fail(`passo "${step.key}" depende de "${need}", que nenhum passo produz — o passo seria inalcancavel`);
      }
    }
  }
  for (const milestone of spec.goalMilestones) {
    if (!yielded.has(milestone)) fail(`goalMilestones cita "${milestone}", que nenhum passo produz`);
  }
  for (const id of spec.goalProbes ?? []) {
    if (!probeIds.has(id)) fail(`goalProbes cita sonda inexistente: ${id}`);
  }
  return spec as WorkspaceSpec;
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

export interface WorkspaceState {
  readonly goal: string;
  /** Marcos OBSERVADOS: concedidos por sonda verde depois de uma execucao real. */
  readonly milestones: readonly string[];
  /** Marcos SUPOSTOS pela arvore. Morrem no executor. Nunca viram observacao. */
  readonly predicted: readonly string[];
  /** Ultima leitura de cada sonda. `null` = nunca medida. */
  readonly probes: Readonly<Record<string, boolean | null>>;
  readonly attempts: Readonly<Record<string, number>>;
  /** Historico curto, com a procedencia escrita em cada linha. */
  readonly log: readonly string[];
  /** Fim da saida das sondas vermelhas: e isto que realimenta a proxima tentativa. */
  readonly failures: Readonly<Record<string, string>>;
  readonly elapsedMs: number;
  readonly budgetMs: number;
  readonly step: number;
  readonly stepCap: number;
  readonly maxAttemptsPerStep: number;
}

export function initialWorkspaceState(
  spec: WorkspaceSpec,
  observed: readonly ProbeResult[] = [],
): WorkspaceState {
  const probes: Record<string, boolean | null> = {};
  for (const probe of spec.probes) probes[probe.id] = null;
  for (const result of observed) probes[result.id] = result.ok;
  const failures: Record<string, string> = {};
  for (const result of observed) if (!result.ok) failures[result.id] = result.error ?? result.tail;
  return {
    goal: spec.goal,
    milestones: [],
    predicted: [],
    probes,
    attempts: {},
    log: observed.length > 0 ? [`observado: sondas medidas na abertura da sessao`] : [],
    failures,
    elapsedMs: 0,
    budgetMs: spec.budgetMs ?? 30 * 60_000,
    step: 0,
    stepCap: spec.stepCap ?? 24,
    maxAttemptsPerStep: spec.maxAttemptsPerStep ?? 2,
  };
}

/**
 * Os tokens disponiveis no estado: marcos e `probe:<id>` das sondas verdes.
 *
 * Inclui os supostos DE PROPOSITO — e o que permite a arvore raciocinar sobre
 * "se este passo funcionar, entao...". A separacao entre supor e observar esta
 * nos campos e no `render`, nao aqui.
 */
export function tokensOf(state: WorkspaceState): Set<string> {
  const out = new Set<string>(state.milestones);
  for (const token of state.predicted) out.add(token);
  for (const [id, ok] of Object.entries(state.probes)) if (ok === true) out.add(`probe:${id}`);
  return out;
}

// ---------------------------------------------------------------------------
// Ambiente
// ---------------------------------------------------------------------------

/**
 * O ambiente de uma tarefa tocada por um agente de CLI.
 *
 * `speculative`, e isso nao e escolha de estilo: `apply` devolve o que se SUPOE
 * que aconteceria se o agente rodasse. Nao existe simulador de "o Claude edita o
 * arquivo". A busca fica presa em profundidade 2, o valor da folha vem do
 * avaliador, e o relatorio diz isso em toda linha.
 *
 * O que e observado de verdade e so o que passou pelo executor e por uma sonda.
 */
export function createWorkspaceEnv(spec: WorkspaceSpec): Environment<WorkspaceState> {
  const byKey = new Map(spec.steps.map((step) => [step.key, step]));
  const goalTokens = [
    ...spec.goalMilestones,
    ...(spec.goalProbes ?? []).map((id) => `probe:${id}`),
  ];

  const isTerminal = (state: WorkspaceState): boolean => {
    if (state.step >= state.stepCap) return true;
    if (state.elapsedMs >= state.budgetMs) return true;
    const have = tokensOf(state);
    return goalTokens.every((token) => have.has(token));
  };

  return {
    name: `workspace:${spec.name}`,
    fidelity: 'speculative',

    actions(state) {
      if (isTerminal(state)) return [];
      const have = tokensOf(state);
      return spec.steps
        .filter((step) => !have.has(step.yields))
        .filter((step) => (state.attempts[step.key] ?? 0) < state.maxAttemptsPerStep)
        // Filtro DURO, ao contrario do exemplo devtask: ali uma ordem ruim nao
        // custa nada, aqui cada passo gasta uma invocacao real do agente.
        .filter((step) => (step.requires ?? []).every((need) => have.has(need)))
        .map<Action>((step) => ({
          key: step.key,
          label: step.label,
          risk: step.risk,
        }));
    },

    apply(state, action) {
      const step = byKey.get(action.key);
      if (!step) throw new Error(`acao fora da spec: ${action.key}`);
      const predicted = new Set(state.predicted);
      predicted.add(step.yields);
      for (const id of step.verify ?? []) predicted.add(`probe:${id}`);
      return {
        ...state,
        predicted: [...predicted],
        attempts: { ...state.attempts, [step.key]: (state.attempts[step.key] ?? 0) + 1 },
        step: state.step + 1,
      };
    },

    terminal: isTerminal,

    // Sem `reward`. O estado da raiz e medido, mas as FOLHAS sao hipoteses, e
    // devolver a medicao da raiz como se fosse o valor de uma folha e justo o
    // tipo de mentira que o relatorio deste repositorio existe para impedir.

    render(state): Json {
      const failing = Object.entries(state.probes)
        .filter(([, ok]) => ok === false)
        .map(([id]) => id);
      const unmeasured = Object.entries(state.probes)
        .filter(([, ok]) => ok === null)
        .map(([id]) => id);
      return {
        objetivo: state.goal,
        marcos_observados: [...state.milestones],
        marcos_supostos_pela_busca: [...state.predicted],
        sondas_verdes: Object.entries(state.probes)
          .filter(([, ok]) => ok === true)
          .map(([id]) => id),
        sondas_vermelhas: failing,
        sondas_nunca_medidas: unmeasured,
        tentativas: { ...state.attempts },
        historico: state.log.slice(-12),
        passo: state.step,
        limite_de_passos: state.stepCap,
      };
    },

    amend(state, instruction) {
      return { ...state, log: [...state.log, `humano: ${instruction}`] };
    },
  };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface ExecutionRecord {
  readonly step: number;
  readonly action: string;
  readonly attempt: number;
  readonly agent: AgentRun | null;
  readonly probes: readonly ProbeResult[];
  readonly granted: string | null;
  readonly ms: number;
}

export interface WorkspaceExecutorOptions {
  readonly spec: WorkspaceSpec;
  readonly runner: AgentRunner;
  readonly cwd?: string;
  readonly journal?: Journal;
  readonly onEvent?: (message: string) => void;
  readonly onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

/**
 * Preenche `{goal}`, `{milestones}`, `{failing}`, `{attempt}` no prompt do passo.
 *
 * `{failing}` e o que fecha o laco: a segunda tentativa de um passo chega ao
 * agente com o fim da saida da sonda que reprovou a primeira.
 */
export function renderPrompt(
  step: WorkspaceStepSpec,
  state: WorkspaceState,
  attempt: number,
): string {
  const failing = Object.entries(state.failures)
    .map(([id, tail]) => `--- sonda "${id}" reprovou ---\n${tail}`)
    .join('\n\n');
  return (step.prompt ?? step.label)
    .replaceAll('{goal}', state.goal)
    .replaceAll('{milestones}', state.milestones.join(', ') || '(nenhum ainda)')
    .replaceAll('{failing}', failing || '(nenhuma sonda reprovando)')
    .replaceAll('{attempt}', String(attempt));
}

/**
 * Onde a suposicao vira observacao.
 *
 * A ordem importa e e o coracao deste modulo:
 *   1. chama o agente (ou nao, se o passo so mede);
 *   2. RE-MEDE as sondas;
 *   3. concede o marco somente se as sondas de `verify` ficaram verdes;
 *   4. joga fora TODA a predicao da arvore.
 *
 * O passo 3 e o que impede um agente de conquistar um marco escrevendo "pronto".
 */
export function createWorkspaceExecutor(options: WorkspaceExecutorOptions): {
  readonly executor: Executor<WorkspaceState>;
  log(): readonly ExecutionRecord[];
} {
  const spec = options.spec;
  const cwd = options.cwd ?? spec.cwd ?? process.cwd();
  const byKey = new Map(spec.steps.map((step) => [step.key, step]));
  const records: ExecutionRecord[] = [];

  const executor: Executor<WorkspaceState> = async (state, action) => {
    const step = byKey.get(action.key);
    if (!step) throw new Error(`acao fora da spec: ${action.key}`);
    const started = Date.now();
    const attempt = (state.attempts[step.key] ?? 0) + 1;
    const log: string[] = [...state.log];

    let agent: AgentRun | null = null;
    if (step.prompt) {
      options.onEvent?.(`executando "${step.key}" via ${options.runner.id} (tentativa ${attempt})`);
      agent = await options.runner.run(renderPrompt(step, state, attempt), {
        cwd,
        timeoutMs: step.timeoutMs ?? 900_000,
        ...(options.onOutput ? { onOutput: options.onOutput } : {}),
      });
      options.journal?.write('agent.run', {
        step: state.step + 1,
        action: step.key,
        runner: agent.runner,
        ok: agent.ok,
        code: agent.code,
        ms: agent.ms,
        timedOut: agent.timedOut,
        // O que o agente AFIRMOU, truncado. Vai para o journal como evidencia de
        // auditoria; continua sem poder nenhum sobre a concessao do marco.
        claimHead: agent.claim.slice(0, 400),
      });
      log.push(
        `agente(${agent.runner}) em "${step.key}": codigo=${agent.code ?? '-'}` +
          (agent.timedOut ? ' TEMPO ESGOTADO' : ''),
      );
    }

    // Re-medicao. Sempre todas: um passo pode quebrar uma sonda que ja estava
    // verde, e um estado que so atualiza o que lhe interessa mente por omissao.
    options.onEvent?.(`medindo ${spec.probes.length} sonda(s)`);
    const probeResults = await observeProbes(spec.probes, { cwd });
    const probes: Record<string, boolean | null> = { ...state.probes };
    const failures: Record<string, string> = {};
    for (const result of probeResults) {
      probes[result.id] = result.ok;
      if (!result.ok) failures[result.id] = result.error ?? result.tail;
    }
    options.journal?.write('probe.observe', {
      step: state.step + 1,
      action: step.key,
      results: probeResults.map((r) => ({ id: r.id, ok: r.ok, code: r.code, ms: r.ms })),
    });

    const verify = step.verify ?? [];
    const verified =
      verify.length > 0
        ? verify.every((id) => probes[id] === true)
        : agent === null || agent.ok;
    // Em dry-run nada foi executado, entao nada pode ter sido conquistado. Sem
    // esta linha, um passo com `verify` vazio (ou com sondas ja verdes) marcharia
    // pelo plano inteiro concedendo marcos que ninguem produziu.
    const granted = verified && !(options.runner.dry && step.prompt) ? step.yields : null;

    if (granted) {
      log.push(
        `observado: "${step.yields}" concedido por ` +
          (verify.length > 0 ? `sonda(s) ${verify.join(', ')}` : 'codigo de saida'),
      );
    } else if (options.runner.dry && step.prompt) {
      log.push(`dry-run: "${step.key}" nao foi executado; nenhum marco concedido`);
    } else {
      const red = verify.filter((id) => probes[id] !== true);
      log.push(
        `observado: "${step.key}" NAO conquistou "${step.yields}" — ` +
          (red.length > 0 ? `sonda(s) ${red.join(', ')}` : 'codigo de saida diferente de zero'),
      );
    }

    const record: ExecutionRecord = {
      step: state.step + 1,
      action: step.key,
      attempt,
      agent,
      probes: probeResults,
      granted,
      ms: Date.now() - started,
    };
    records.push(record);

    return {
      ...state,
      milestones: granted ? [...new Set([...state.milestones, granted])] : [...state.milestones],
      // A arvore supos; o mundo respondeu. Nada do palpite sobrevive a resposta.
      predicted: [],
      probes,
      failures,
      attempts: { ...state.attempts, [step.key]: attempt },
      log: log.slice(-64),
      elapsedMs: state.elapsedMs + record.ms,
      step: state.step + 1,
    };
  };

  return { executor, log: () => records };
}

export function formatExecutionLog(records: readonly ExecutionRecord[]): string {
  if (records.length === 0) return 'execucao  : nada foi executado nesta corrida';
  const lines = ['execucao  :'];
  for (const record of records) {
    const agent = record.agent
      ? `${record.agent.runner} codigo=${record.agent.code ?? '-'} ${record.agent.ms} ms`
      : 'so medicao (passo sem prompt)';
    lines.push(
      `  passo ${record.step} ${record.action} (tentativa ${record.attempt}) — ${agent}`,
    );
    for (const probe of record.probes) {
      lines.push(`      sonda ${probe.ok ? 'VERDE' : 'VERM.'} ${probe.id} (${probe.ms} ms)`);
    }
    lines.push(
      record.granted
        ? `      => marco "${record.granted}" CONCEDIDO por medicao`
        : `      => nenhum marco concedido`,
    );
  }
  return lines.join('\n');
}

/**
 * Heuristica offline, para rodar o laco inteiro sem gastar rede.
 *
 * Nao e um oraculo e nao tenta ser: ela so sabe contar quantos tokens do
 * objetivo ja existem e se os pre-requisitos declarados estao satisfeitos — mais
 * ou menos o que um classificador enxerga lendo o estado renderizado. Serve para
 * exercitar o harness; o julgamento de verdade e o do Jev ou o do humano.
 */
export function workspaceHeuristic(spec: WorkspaceSpec): {
  candidate(state: unknown, label: string): number;
  state(state: unknown): number;
} {
  const goalTokens = [
    ...spec.goalMilestones,
    ...(spec.goalProbes ?? []).map((id) => `probe:${id}`),
  ];
  const read = (state: unknown): Set<string> => {
    const view = (state ?? {}) as Record<string, unknown>;
    const out = new Set<string>();
    for (const key of ['marcos_observados', 'marcos_supostos_pela_busca']) {
      for (const token of (view[key] as string[] | undefined) ?? []) out.add(token);
    }
    for (const id of (view['sondas_verdes'] as string[] | undefined) ?? []) out.add(`probe:${id}`);
    return out;
  };

  return {
    candidate(state, label) {
      const have = read(state);
      const step = spec.steps.find((s) => s.label === label);
      if (!step) return 0.2;
      if (have.has(step.yields)) return 0.05;
      const need = step.requires ?? [];
      const met = need.filter((token) => have.has(token)).length;
      if (need.length === 0) return 0.9;
      return met === need.length ? 0.92 : met === 0 ? 0.1 : 0.45;
    },
    state(state) {
      const have = read(state);
      if (goalTokens.length === 0) return 0;
      return goalTokens.filter((token) => have.has(token)).length / goalTokens.length;
    },
  };
}
