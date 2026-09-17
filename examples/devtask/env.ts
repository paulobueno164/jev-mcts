import type { Action, Json, RiskClass } from '../../src/core/types.js';
import type { Environment } from '../../src/env/environment.js';

/**
 * Planejar os proximos passos de uma tarefa de software.
 *
 * Este ambiente e `speculative` e isso NAO e um detalhe de implementacao: aqui
 * nao existe simulador. `apply` devolve o que se SUPOE que o estado viraria, nao
 * o que ele vira. Por isso a busca fica presa em profundidade 2, o valor da
 * folha vem do avaliador (e o relatorio diz isso), e nenhuma acao costly ou
 * irreversivel passa sem um humano.
 *
 * O que e observado de verdade e so o que passou pelo executor.
 */
export interface DevTaskState {
  readonly goal: string;
  /** Fatos conhecidos. Prefixo "observado:" = veio da execucao. "previsto:" = suposicao da arvore. */
  readonly facts: readonly string[];
  readonly done: readonly string[];
  readonly amendments: readonly string[];
  readonly step: number;
  readonly stepCap: number;
}

export interface TaskAction {
  readonly key: string;
  readonly label: string;
  readonly risk: RiskClass;
  /** Marcos que precisam existir antes. */
  readonly requires: readonly string[];
  /** Marco que a acao produz. */
  readonly yields: string;
}

export const CATALOG: readonly TaskAction[] = Object.freeze([
  { key: 'ler-spec', label: 'Ler a especificacao e listar os criterios de aceitacao', risk: 'safe', requires: [], yields: 'spec' },
  { key: 'mapear-codigo', label: 'Mapear os modulos afetados e os pontos de entrada', risk: 'safe', requires: [], yields: 'mapa' },
  { key: 'rodar-typecheck', label: 'Rodar o typecheck e ler os erros', risk: 'safe', requires: [], yields: 'typecheck' },
  { key: 'escrever-teste', label: 'Escrever o teste que falha antes da correcao', risk: 'reversible', requires: ['spec'], yields: 'teste' },
  { key: 'implementar', label: 'Implementar a mudanca no modulo mapeado', risk: 'reversible', requires: ['spec', 'mapa'], yields: 'codigo' },
  { key: 'rodar-testes', label: 'Rodar a suite inteira e ler a saida', risk: 'safe', requires: ['codigo'], yields: 'verde' },
  { key: 'refatorar', label: 'Refatorar o modulo vizinho aproveitando a viagem', risk: 'reversible', requires: ['mapa'], yields: 'refatorado' },
  { key: 'abrir-pr', label: 'Abrir o pull request com o diff e o resultado da suite', risk: 'reversible', requires: ['verde'], yields: 'pr' },
  { key: 'rodar-migracao', label: 'Rodar a migracao de banco em staging', risk: 'costly', requires: ['codigo'], yields: 'migrado' },
  { key: 'publicar', label: 'Publicar em producao', risk: 'irreversible', requires: ['pr'], yields: 'publicado' },
  { key: 'apagar-branch', label: 'Apagar o branch remoto', risk: 'costly', requires: ['pr'], yields: 'limpo' },
]);

const BY_KEY = new Map(CATALOG.map((a) => [a.key, a]));

/** Marcos do caminho feliz, usados so para pontuar progresso. */
const GOAL_MILESTONES = ['spec', 'mapa', 'codigo', 'verde', 'pr', 'publicado'] as const;

export function milestones(state: DevTaskState): Set<string> {
  const out = new Set<string>();
  for (const fact of state.facts) {
    const colon = fact.indexOf(':');
    if (colon > 0) out.add(fact.slice(colon + 1).split(' ')[0] as string);
  }
  return out;
}

export function initialState(goal: string, stepCap = 10): DevTaskState {
  return { goal, facts: [], done: [], amendments: [], step: 0, stepCap };
}

function isTerminal(state: DevTaskState): boolean {
  if (state.step >= state.stepCap) return true;
  // A tarefa so termina publicada. E de proposito: o unico caminho ate o fim
  // passa por uma acao irreversivel, e portanto por um humano.
  return milestones(state).has('publicado');
}

export function createDevTaskEnv(): Environment<DevTaskState> {
  return {
    name: 'devtask',
    fidelity: 'speculative',

    actions(state) {
      if (isTerminal(state)) return [];
      const have = milestones(state);
      return CATALOG.filter((a) => !have.has(a.yields)).map<Action>((a) => ({
        key: a.key,
        label: a.requires.length > 0 ? `${a.label} (depende de: ${a.requires.join(', ')})` : a.label,
        risk: a.risk,
      }));
    },

    /** SUPOSICAO, nao observacao: o fato nasce com o prefixo "previsto:". */
    apply(state, action) {
      const task = BY_KEY.get(action.key);
      if (!task) throw new Error(`acao fora do catalogo: ${action.key}`);
      return {
        ...state,
        facts: [...state.facts, `previsto:${task.yields} apos "${task.key}"`],
        done: [...state.done, task.key],
        step: state.step + 1,
      };
    },

    terminal: isTerminal,

    // Sem `reward`: este ambiente nao sabe medir nada. O valor da folha vai ter
    // de vir do avaliador, e vai ficar marcado como estimativa no relatorio.

    render(state): Json {
      return {
        objetivo: state.goal,
        fatos: [...state.facts],
        ja_feito: [...state.done],
        instrucoes_do_humano: [...state.amendments],
        passo: state.step,
        limite: state.stepCap,
      };
    },

    amend(state, instruction) {
      return { ...state, amendments: [...state.amendments, instruction] };
    },
  };
}

/**
 * O executor: e aqui que a suposicao vira observacao. Num uso real este corpo
 * roda o comando e le a saida; o que muda e a procedencia do fato, e ela e a
 * unica coisa que separa um plano de um resultado.
 */
export function createDevTaskExecutor(): (state: DevTaskState, action: Action) => DevTaskState {
  return (state, action) => {
    const task = BY_KEY.get(action.key);
    if (!task) throw new Error(`acao fora do catalogo: ${action.key}`);
    return {
      ...state,
      facts: [...state.facts, `observado:${task.yields} apos executar "${task.key}"`],
      done: [...state.done, task.key],
      step: state.step + 1,
    };
  };
}

/**
 * Heuristica offline no lugar do Jev. Nao e um oraculo: ela so sabe se os
 * pre-requisitos declarados estao satisfeitos, que e mais ou menos o que um
 * classificador consegue ver lendo o estado.
 */
export function devTaskHeuristic() {
  const readState = (state: unknown): DevTaskState =>
    (state as { objetivo?: string }) && typeof state === 'object'
      ? ({
          goal: String((state as Record<string, unknown>)['objetivo'] ?? ''),
          facts: ((state as Record<string, unknown>)['fatos'] as string[]) ?? [],
          done: ((state as Record<string, unknown>)['ja_feito'] as string[]) ?? [],
          amendments: ((state as Record<string, unknown>)['instrucoes_do_humano'] as string[]) ?? [],
          step: Number((state as Record<string, unknown>)['passo'] ?? 0),
          stepCap: Number((state as Record<string, unknown>)['limite'] ?? 10),
        } as DevTaskState)
      : initialState('');

  return {
    candidate(state: unknown, label: string): number {
      const parsed = readState(state);
      const have = milestones(parsed);
      const task = CATALOG.find((a) => label.startsWith(a.label));
      if (!task) return 0.2;
      const met = task.requires.filter((r) => have.has(r)).length;
      if (task.requires.length === 0) return have.has(task.yields) ? 0.1 : 0.93;
      if (met === task.requires.length) return 0.94;
      return met === 0 ? 0.08 : 0.45;
    },
    state(state: unknown): number {
      const parsed = readState(state);
      const have = milestones(parsed);
      const hit = GOAL_MILESTONES.filter((m) => have.has(m)).length;
      return hit / GOAL_MILESTONES.length;
    },
  };
}
