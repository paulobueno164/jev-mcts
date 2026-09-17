import { describe, expect, it } from 'vitest';
import {
  EvaluatorUnavailableError,
  isTransient,
  withRetry,
} from '../src/evaluator/resilient.js';
import { EMPTY_USAGE, type Evaluator } from '../src/evaluator/evaluator.js';
import { run } from '../src/orchestration/orchestrator.js';
import type { Environment } from '../src/env/environment.js';
import type { Action } from '../src/core/types.js';

/** Avaliador que falha as `falhas` primeiras chamadas e depois responde. */
function avaliadorInstavel(falhas: number, erro: unknown): { evaluator: Evaluator; chamadas: () => number } {
  let n = 0;
  const talvez = async (): Promise<never | void> => {
    n++;
    if (n <= falhas) throw erro;
  };
  const evaluator: Evaluator = {
    id: 'instavel',
    async screen({ candidates }) {
      await talvez();
      return {
        probability: Object.fromEntries(candidates.map((c) => [c.key, 0.5])),
        usage: EMPTY_USAGE,
        calls: 1,
      };
    },
    async priors({ candidates }) {
      await talvez();
      const p = 1 / Math.max(1, candidates.length);
      return {
        distribution: Object.fromEntries(candidates.map((c) => [c.key, p])),
        top: candidates[0]?.key ?? '',
        usage: EMPTY_USAGE,
        calls: 1,
      };
    },
    async value() {
      await talvez();
      return { value: 0.5, raw: 1, usage: EMPTY_USAGE, calls: 1 };
    },
  };
  return { evaluator, chamadas: () => n };
}

const semDormir = async (): Promise<void> => {};

const erro429 = Object.assign(new Error('Free tier requests on this model are rate-limited.'), {
  name: 'GatewayRateLimitError',
  statusCode: 429,
});

describe('classificacao de erro do avaliador', () => {
  it('429 do gateway e transitorio', () => {
    expect(isTransient(erro429)).toBe(true);
  });

  it('credencial invalida NAO e transitoria: repetir so atrasa o diagnostico', () => {
    expect(isTransient(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))).toBe(false);
  });

  it('erro de servidor e transitorio', () => {
    expect(isTransient(Object.assign(new Error('bad gateway'), { statusCode: 502 }))).toBe(true);
  });

  it('enxerga o 429 escondido dentro de cause', () => {
    const embrulhado = new Error('Failed after 3 attempts', { cause: erro429 });
    expect(isTransient(embrulhado)).toBe(true);
  });

  it('erro comum de programacao nao vira repeticao', () => {
    expect(isTransient(new TypeError('x is not a function'))).toBe(false);
  });
});

describe('withRetry', () => {
  it('atravessa uma falha transitoria e devolve a resposta boa', async () => {
    const { evaluator, chamadas } = avaliadorInstavel(2, erro429);
    const resiliente = withRetry(evaluator, { attempts: 4, sleep: semDormir });
    const r = await resiliente.value({ state: 's', question: 'q', levels: ['ruim', 'bom', 'otimo'] });
    expect(r.value).toBe(0.5);
    expect(chamadas()).toBe(3);
  });

  it('desiste com erro TIPADO depois do teto de tentativas', async () => {
    const { evaluator, chamadas } = avaliadorInstavel(99, erro429);
    const resiliente = withRetry(evaluator, { attempts: 3, sleep: semDormir });
    await expect(
      resiliente.value({ state: 's', question: 'q', levels: ['a', 'b'] }),
    ).rejects.toBeInstanceOf(EvaluatorUnavailableError);
    expect(chamadas()).toBe(3);
  });

  it('nao insiste em erro permanente: uma chamada so', async () => {
    const { evaluator, chamadas } = avaliadorInstavel(
      99,
      Object.assign(new Error('Unauthorized'), { statusCode: 401 }),
    );
    const resiliente = withRetry(evaluator, { attempts: 5, sleep: semDormir });
    await expect(resiliente.screen({ state: 's', question: 'q', candidates: [] })).rejects.toBeInstanceOf(
      EvaluatorUnavailableError,
    );
    expect(chamadas()).toBe(1);
  });

  it('espera dobrando, e respeita o teto', async () => {
    const esperas: number[] = [];
    const { evaluator } = avaliadorInstavel(99, erro429);
    const resiliente = withRetry(evaluator, {
      attempts: 5,
      baseDelayMs: 1000,
      maxDelayMs: 3000,
      sleep: async (ms) => {
        esperas.push(ms);
      },
    });
    await expect(resiliente.value({ state: 's', question: 'q', levels: ['a', 'b'] })).rejects.toThrow();
    expect(esperas).toEqual([1000, 2000, 3000, 3000]);
  });
});

// ---------------------------------------------------------------------------
// O que isto tudo existe para impedir
// ---------------------------------------------------------------------------

interface EstadoBobo {
  readonly feitos: readonly string[];
}

function ambienteBobo(): Environment<EstadoBobo> {
  const acoes: Action[] = [
    { key: 'a', label: 'passo a', risk: 'reversible' },
    { key: 'b', label: 'passo b', risk: 'reversible' },
  ];
  return {
    name: 'bobo',
    fidelity: 'speculative',
    actions: (s) => (s.feitos.length >= 2 ? [] : acoes.filter((a) => !s.feitos.includes(a.key))),
    apply: (s, a) => ({ feitos: [...s.feitos, a.key] }),
    terminal: (s) => s.feitos.length >= 2,
    render: (s) => ({ feitos: [...s.feitos] }),
  };
}

describe('avaliador fora do ar no meio de uma corrida', () => {
  it('para limpo com stoppedBy, em vez de derrubar a corrida e levar o progresso junto', async () => {
    // O avaliador so cai DEPOIS que um passo de verdade foi executado. E esse o
    // caso que interessa: ha progresso no estado quando a rede morre.
    const env = ambienteBobo();
    let executados = 0;
    const cair = (): void => {
      if (executados >= 1) throw erro429;
    };
    const instavel: Evaluator = {
      id: 'cai-depois-do-primeiro',
      async screen({ candidates }) {
        cair();
        return {
          probability: Object.fromEntries(candidates.map((c) => [c.key, 0.9])),
          usage: EMPTY_USAGE,
          calls: 1,
        };
      },
      async priors({ candidates }) {
        cair();
        const p = 1 / Math.max(1, candidates.length);
        return {
          distribution: Object.fromEntries(candidates.map((c) => [c.key, p])),
          top: candidates[0]?.key ?? '',
          usage: EMPTY_USAGE,
          calls: 1,
        };
      },
      async value() {
        cair();
        return { value: 0.9, raw: 1, usage: EMPTY_USAGE, calls: 1 };
      },
    };

    const resultado = await run<EstadoBobo>(
      { feitos: [] },
      {
        env,
        evaluator: withRetry(instavel, { attempts: 2, sleep: semDormir }),
        goal: 'fazer a e b',
        maxSteps: 4,
        executor: (state, action) => {
          executados++;
          return env.apply(state, action);
        },
        search: { iterations: 12, budget: { calls: 10_000, wallMs: 30_000 } },
        // Portoes frouxos de proposito: aqui o que esta sob teste e a queda do
        // avaliador, nao a regra de escalada.
        gates: {
          escalateOnSpeculativeValue: false,
          minMargin: 0,
          minConfidence: 0,
          minConfidenceUncalibrated: 0,
          minGroundedFraction: 0,
        },
      },
    );

    expect(resultado.stopped).toBe('evaluator-unavailable');
    // O ponto inteiro: o que ja tinha sido feito continua no estado final.
    expect(resultado.finalState.feitos.length).toBeGreaterThan(0);
  });
});
