import type { Action, Json } from '../../src/core/types.js';
import type { Environment } from '../../src/env/environment.js';

/**
 * Duelo deterministico de um agente contra um bot guloso fixo.
 *
 * Existe por um motivo so: aqui a VERDADE e conhecida. O ambiente sabe dizer
 * quem venceu, entao da para medir o quanto a busca ajuda e o quanto o prior do
 * Jev ajuda, em vez de aceitar um numero de acuracia publicado por terceiro.
 *
 * O desenho e o caso classico que uma heuristica de 1 ply nao enxerga: o golpe
 * de maior dano por recarga vence toda comparacao local, e mesmo assim perde a
 * luta, porque o golpe que cura tem recompensa atrasada.
 */
export interface Move {
  readonly key: string;
  readonly label: string;
  readonly damage: number;
  readonly heal: number;
  /** Turnos de recarga apos o uso. */
  readonly cooldown: number;
  /** Reduz o proximo dano recebido nesta fracao. */
  readonly shield: number;
}

export const MOVES: readonly Move[] = Object.freeze([
  { key: 'strike', label: 'Golpe rapido: 16 de dano, sem recarga', damage: 16, heal: 0, cooldown: 0, shield: 0 },
  { key: 'heavy', label: 'Golpe pesado: 30 de dano, 3 turnos de recarga', damage: 30, heal: 0, cooldown: 3, shield: 0 },
  { key: 'drain', label: 'Dreno: 6 de dano e 26 de cura, 2 turnos de recarga', damage: 6, heal: 26, cooldown: 2, shield: 0 },
  { key: 'guard', label: 'Guarda: sem dano, corta 70% do proximo dano recebido, 3 turnos de recarga', damage: 0, heal: 0, cooldown: 3, shield: 0.7 },
]);

const MOVE_BY_KEY = new Map(MOVES.map((m) => [m.key, m]));

export interface Side {
  readonly hp: number;
  readonly maxHp: number;
  readonly cd: Readonly<Record<string, number>>;
  readonly shield: number;
}

export interface DuelState {
  readonly agent: Side;
  readonly bot: Side;
  readonly ply: number;
  readonly plyCap: number;
}

export interface DuelScenario {
  readonly id: string;
  readonly agentHp: number;
  readonly botHp: number;
  readonly plyCap: number;
}

function freshSide(hp: number): Side {
  const cd: Record<string, number> = {};
  for (const move of MOVES) cd[move.key] = 0;
  return { hp, maxHp: hp, cd, shield: 0 };
}

export function initialState(scenario: DuelScenario): DuelState {
  return {
    agent: freshSide(scenario.agentHp),
    bot: freshSide(scenario.botHp),
    ply: 0,
    plyCap: scenario.plyCap,
  };
}

function tick(side: Side): Side {
  const cd: Record<string, number> = {};
  for (const [key, value] of Object.entries(side.cd)) cd[key] = Math.max(0, value - 1);
  return { ...side, cd };
}

function available(side: Side): Move[] {
  return MOVES.filter((move) => (side.cd[move.key] ?? 0) === 0);
}

/** Politica gulosa de 1 ply: maximiza dano por recarga. E o bot, e e o baseline. */
export function greedyMove(side: Side): Move {
  const options = available(side);
  const head = options[0] ?? (MOVES[0] as Move);
  return options.reduce((best, move) => {
    const score = move.damage / (move.cooldown + 1);
    const bestScore = best.damage / (best.cooldown + 1);
    return score > bestScore ? move : best;
  }, head);
}

function strike(attacker: Side, defender: Side, move: Move): { attacker: Side; defender: Side } {
  const incoming = Math.round(move.damage * (1 - defender.shield));
  const nextDefender: Side = {
    ...defender,
    hp: defender.hp - incoming,
    shield: move.damage > 0 ? 0 : defender.shield,
  };
  const cd: Record<string, number> = { ...attacker.cd };
  cd[move.key] = move.cooldown;
  const nextAttacker: Side = {
    ...attacker,
    hp: Math.min(attacker.maxHp, attacker.hp + move.heal),
    cd,
    shield: move.shield > 0 ? move.shield : attacker.shield,
  };
  return { attacker: nextAttacker, defender: nextDefender };
}

function isTerminal(state: DuelState): boolean {
  return state.agent.hp <= 0 || state.bot.hp <= 0 || state.ply >= state.plyCap;
}

export function createDuelEnv(): Environment<DuelState> {
  return {
    name: 'duel',
    fidelity: 'grounded',

    actions(state) {
      if (isTerminal(state)) return [];
      return available(state.agent).map<Action>((move) => ({
        key: move.key,
        label: move.label,
        risk: 'safe',
      }));
    },

    apply(state, action) {
      const move = MOVE_BY_KEY.get(action.key);
      if (!move) throw new Error(`golpe desconhecido: ${action.key}`);

      let agent = tick(state.agent);
      let bot = state.bot;
      ({ attacker: agent, defender: bot } = strike(agent, bot, move));

      if (bot.hp > 0) {
        bot = tick(bot);
        const reply = greedyMove(bot);
        ({ attacker: bot, defender: agent } = strike(bot, agent, reply));
      }
      return { ...state, agent, bot, ply: state.ply + 1 };
    },

    terminal: isTerminal,

    reward(state) {
      if (state.bot.hp <= 0 && state.agent.hp > 0) return 1;
      if (state.agent.hp <= 0) return 0;
      if (state.ply >= state.plyCap) {
        // Empate por tempo: fica no meio, ponderado pela vantagem de vida, e
        // nunca alcanca 1. Sobreviver nao pode valer o mesmo que vencer.
        const diff = state.agent.hp / state.agent.maxHp - state.bot.hp / state.bot.maxHp;
        return Math.min(0.75, Math.max(0.25, 0.5 + diff / 2));
      }
      return undefined;
    },

    render(state): Json {
      return {
        objetivo: 'derrotar o oponente antes de cair',
        agente: { vida: state.agent.hp, max: state.agent.maxHp, recargas: state.agent.cd },
        oponente: { vida: state.bot.hp, max: state.bot.maxHp, recargas: state.bot.cd },
        turno: state.ply,
        limite: state.plyCap,
      };
    },
  };
}

export function duelScenarios(count: number): DuelScenario[] {
  const out: DuelScenario[] = [];
  for (let i = 0; i < count; i++) {
    const botHp = 110 + (i % 8) * 5;
    const agentHp = 100 - (i % 3) * 5;
    out.push({ id: `s${i}:agent${agentHp}-bot${botHp}`, agentHp, botHp, plyCap: 60 });
  }
  return out;
}

/** Joga a partida inteira com a politica gulosa. Baseline sem nenhuma busca. */
export function playGreedy(scenario: DuelScenario): { won: boolean; reward: number; plies: number } {
  const env = createDuelEnv();
  let state = initialState(scenario);
  while (!env.terminal(state)) {
    const move = greedyMove(state.agent);
    state = env.apply(state, { key: move.key, label: move.label, risk: 'safe' });
  }
  const reward = env.reward?.(state) ?? 0;
  return { won: state.bot.hp <= 0 && state.agent.hp > 0, reward, plies: state.ply };
}
