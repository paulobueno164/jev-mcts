import type { Action, Json } from '../core/types.js';
import type { Rng } from '../core/rng.js';

/**
 * De onde vem o proximo estado.
 *
 *  - 'grounded'    : `apply` devolve o estado real. Regras de um jogo, uma funcao
 *                    pura, um simulador determinista. A busca pode ir fundo, porque
 *                    profundidade aqui reduz incerteza.
 *  - 'speculative' : `apply` devolve o palpite de alguem sobre o que o estado viraria.
 *                    A busca e limitada a `speculativeMaxDepth` e todo no nasce
 *                    marcado; profundidade aqui COMPOE erro em vez de reduzi-lo.
 *
 * Essa distincao e o motivo do repositorio existir. Ela nao e configuravel por
 * prompt e nao pode ser afrouxada em tempo de execucao.
 */
export type Fidelity = 'grounded' | 'speculative';

export interface Environment<S> {
  readonly name: string;
  readonly fidelity: Fidelity;

  /** Acoes legais no estado. Cada uma ja traz sua classe de risco. */
  actions(state: S): readonly Action[];

  /** Proximo estado. Puro: mesma entrada, mesma saida. Nao faz I/O. */
  apply(state: S, action: Action): S;

  terminal(state: S): boolean;

  /**
   * Recompensa real em [0,1], quando o ambiente sabe medir. `undefined` obriga a
   * busca a cair no avaliador (Jev) e a marcar o valor como 'jev-score'.
   */
  reward?(state: S): number | undefined;

  /** O que o avaliador ve. Texto ou JSON; e o que vai no cache e no journal. */
  render(state: S): string | Json;

  /** Politica de playout. Default: uniforme sobre `actions`. */
  rolloutPolicy?(state: S, rng: Rng): Action;

  /**
   * Aplica uma instrucao textual do humano ao estado (resposta "emendar" do
   * portao). Ambiente que nao sabe emendar simplesmente nao implementa, e a
   * emenda vira abortar em vez de ser silenciosamente ignorada.
   */
  amend?(state: S, instruction: string): S;
}

export function isGrounded<S>(env: Environment<S>): boolean {
  return env.fidelity === 'grounded';
}

/**
 * Playout ate o terminal ou ate `maxDepth`. So faz sentido em ambiente grounded:
 * rolar adiante um modelo de transicao inventado nao mede nada.
 */
export function rollout<S>(
  env: Environment<S>,
  start: S,
  rng: Rng,
  maxDepth: number,
): { state: S; depth: number; reward: number | undefined } {
  if (env.fidelity !== 'grounded') {
    throw new Error(
      `rollout() chamado em ambiente speculative "${env.name}": playout sobre transicao inventada nao e medicao`,
    );
  }
  let state = start;
  let depth = 0;
  while (depth < maxDepth && !env.terminal(state)) {
    const options = env.actions(state);
    if (options.length === 0) break;
    const action = env.rolloutPolicy ? env.rolloutPolicy(state, rng) : rng.pick(options);
    state = env.apply(state, action);
    depth++;
  }
  return { state, depth, reward: env.reward?.(state) };
}
