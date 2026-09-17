import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Testes de contrato do adaptador do Jev.
 *
 * O `experimental_evaluate` do AI SDK e substituido por um duble que GRAVA os
 * argumentos. Isto nao prova que a API remota se comporta como o duble — nada
 * aqui fala com a rede, e o formato real das respostas continua nao verificado.
 * O que prova e o lado de ca: que o adaptador monta o slate, parte em blocos,
 * embaralha de forma determinista, faz a media das passadas de debias e devolve
 * cada resposta para a CHAVE certa em vez de para a posicao. Era exatamente
 * isso que nao tinha teste nenhum.
 */

interface EvalArgs {
  model: string;
  state: { context?: unknown; candidates?: { ref: string; action: string }[] } & Record<string, unknown>;
  questions: Record<string, { type: string; instructions: string; criteria?: unknown }>;
  providerOptions?: { gateway?: { zeroDataRetention?: boolean } };
  maxRetries?: number;
  abortSignal?: AbortSignal;
}

const ai = vi.hoisted(() => ({
  calls: [] as EvalArgs[],
  handler: ((): unknown => ({ answers: {} })) as (args: EvalArgs) => unknown,
}));

vi.mock('ai', () => ({
  experimental_evaluate: async (args: EvalArgs): Promise<unknown> => {
    ai.calls.push(args);
    return ai.handler(args);
  },
}));

import {
  createJevEvaluator,
  jevCredentialsPresent,
  resolveJevCredential,
} from '../src/evaluator/jev.js';

/** Rotulos que carregam o proprio indice, para o teste checar o mapeamento. */
function candidates(n: number): { key: string; label: string }[] {
  return Array.from({ length: n }, (_, i) => ({ key: `k${i}`, label: `acao-${i}` }));
}

function indexOfLabel(label: string): number {
  const match = /acao-(\d+)/.exec(label);
  if (!match) throw new Error(`rotulo inesperado: ${label}`);
  return Number(match[1]);
}

function slate(call: EvalArgs | undefined): { ref: string; action: string }[] {
  return call?.state.candidates ?? [];
}

const usage = { inputTokens: 100, outputTokens: 5 };

beforeEach(() => {
  ai.calls.length = 0;
  ai.handler = () => ({ answers: {} });
  // O adaptador le JEV_MODEL como default; o teste do modelo padrao exige que
  // o ambiente da maquina nao interfira.
  delete process.env['JEV_MODEL'];
});

describe('screen — triagem em slate', () => {
  it('N candidatos custam UMA chamada, com uma pergunta booleana por candidato', async () => {
    ai.handler = (args) => {
      const answers: Record<string, unknown> = {};
      Object.keys(args.questions).forEach((id, i) => {
        answers[id] = { probability: i / 10 };
      });
      return { answers, usage };
    };

    const result = await createJevEvaluator().screen({
      state: { objetivo: 'x' },
      question: 'serve?',
      candidates: candidates(5),
    });

    expect(ai.calls).toHaveLength(1);
    expect(result.calls).toBe(1);
    const call = ai.calls[0] as EvalArgs;
    expect(Object.keys(call.questions)).toHaveLength(5);
    expect(Object.values(call.questions).every((q) => q.type === 'boolean')).toBe(true);
    expect(call.state.context).toEqual({ objetivo: 'x' });
    expect(slate(call)).toHaveLength(5);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 5 });
  });

  it('a resposta volta para a CHAVE do candidato, nao para a posicao', async () => {
    // O adaptador embaralha a ordem antes de perguntar. Se o mapeamento de
    // volta fosse posicional, este teste quebraria.
    ai.handler = (args) => {
      const answers: Record<string, unknown> = {};
      slate(args).forEach((candidate, i) => {
        answers[`q${i}`] = { probability: indexOfLabel(candidate.action) / 10 };
      });
      return { answers, usage };
    };

    const result = await createJevEvaluator().screen({
      state: 'contexto',
      question: 'serve?',
      candidates: candidates(6),
    });

    for (let i = 0; i < 6; i++) {
      expect(result.probability[`k${i}`]).toBeCloseTo(i / 10, 10);
    }
  });

  it('a ordem chega embaralhada, e nao na ordem em que foi passada', async () => {
    ai.handler = () => ({ answers: {}, usage });
    await createJevEvaluator({ seed: 'embaralha' }).screen({
      state: 's',
      question: 'q',
      candidates: candidates(8),
    });
    const asked = slate(ai.calls[0]).map((c) => c.action);
    const natural = candidates(8).map((c) => c.label);
    expect(asked).not.toEqual(natural);
    expect([...asked].sort()).toEqual([...natural].sort());
  });

  it('a mesma semente produz a mesma ordem; sementes diferentes, ordens diferentes', async () => {
    ai.handler = () => ({ answers: {}, usage });
    const orderFor = async (seed: string): Promise<string[]> => {
      ai.calls.length = 0;
      await createJevEvaluator({ seed }).screen({
        state: 's',
        question: 'q',
        candidates: candidates(8),
      });
      return slate(ai.calls[0]).map((c) => c.action);
    };
    expect(await orderFor('a')).toEqual(await orderFor('a'));
    const orders = [await orderFor('s1'), await orderFor('s2'), await orderFor('s3')];
    expect(new Set(orders.map((o) => o.join('|'))).size).toBeGreaterThan(1);
  });

  it('parte em blocos de maxQuestionsPerCall e cobre cada candidato uma vez', async () => {
    ai.handler = (args) => {
      const answers: Record<string, unknown> = {};
      slate(args).forEach((candidate, i) => {
        answers[`q${i}`] = { probability: indexOfLabel(candidate.action) / 100 };
      });
      return { answers, usage };
    };

    const result = await createJevEvaluator({ maxQuestionsPerCall: 8 }).screen({
      state: 's',
      question: 'q',
      candidates: candidates(20),
    });

    expect(ai.calls).toHaveLength(3);
    expect(result.calls).toBe(3);
    for (const call of ai.calls) {
      expect(Object.keys(call.questions).length).toBeLessThanOrEqual(8);
      expect(slate(call).length).toBe(Object.keys(call.questions).length);
    }
    const seen = ai.calls.flatMap((c) => slate(c).map((x) => x.action));
    expect(seen).toHaveLength(20);
    expect(new Set(seen).size).toBe(20);
    for (let i = 0; i < 20; i++) {
      expect(result.probability[`k${i}`]).toBeCloseTo(i / 100, 10);
    }
    // Uso somado entre os blocos, nao o do ultimo.
    expect(result.usage.inputTokens).toBe(300);
  });

  it('as refs do slate sao continuas entre blocos', async () => {
    ai.handler = () => ({ answers: {}, usage });
    await createJevEvaluator({ maxQuestionsPerCall: 4 }).screen({
      state: 's',
      question: 'q',
      candidates: candidates(10),
    });
    const refs = ai.calls.flatMap((c) => slate(c).map((x) => x.ref));
    expect(refs).toEqual(Array.from({ length: 10 }, (_, i) => `c${i}`));
  });

  it('a instrucao de cada pergunta nomeia o candidato e a ref dele', async () => {
    ai.handler = () => ({ answers: {}, usage });
    await createJevEvaluator({ maxQuestionsPerCall: 4 }).screen({
      state: 's',
      question: 'vale a pena?',
      candidates: candidates(6),
    });
    for (const call of ai.calls) {
      const asked = slate(call);
      Object.values(call.questions).forEach((q, i) => {
        const candidate = asked[i] as { ref: string; action: string };
        expect(q.instructions).toContain('vale a pena?');
        expect(q.instructions).toContain(candidate.action);
        expect(q.instructions).toContain(`ref ${candidate.ref}`);
      });
    }
  });

  it('debiasPasses 2 dobra as chamadas e tira a media das duas ordens', async () => {
    let pass = 0;
    ai.handler = (args) => {
      const value = pass++ === 0 ? 0.2 : 0.8;
      const answers: Record<string, unknown> = {};
      Object.keys(args.questions).forEach((id) => {
        answers[id] = { probability: value };
      });
      return { answers, usage };
    };

    const result = await createJevEvaluator({ debiasPasses: 2 }).screen({
      state: 's',
      question: 'q',
      candidates: candidates(4),
    });

    expect(ai.calls).toHaveLength(2);
    expect(result.calls).toBe(2);
    expect(result.usage.inputTokens).toBe(200);
    for (let i = 0; i < 4; i++) {
      expect(result.probability[`k${i}`]).toBeCloseTo(0.5, 10);
    }
  });

  it('a segunda passada pergunta na ordem inversa da primeira', async () => {
    ai.handler = () => ({ answers: {}, usage });
    await createJevEvaluator({ debiasPasses: 2 }).screen({
      state: 's',
      question: 'q',
      candidates: candidates(5),
    });
    const first = slate(ai.calls[0]).map((c) => c.action);
    const second = slate(ai.calls[1]).map((c) => c.action);
    expect(second).toEqual([...first].reverse());
  });

  it('resposta ausente, NaN ou fora de [0,1] nao vira lixo silencioso', async () => {
    ai.handler = () => ({
      answers: {
        q0: { probability: 2 },
        q1: { probability: -1 },
        q2: { probability: 'oi' },
        q3: {},
        // q4 ausente de proposito
      },
      usage,
    });
    const result = await createJevEvaluator().screen({
      state: 's',
      question: 'q',
      candidates: candidates(5),
    });
    const values = Object.values(result.probability);
    expect(values).toHaveLength(5);
    expect(values.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(values.filter((v) => v === 0.5)).toHaveLength(3);
    expect(values).toContain(1);
    expect(values).toContain(0);
  });
});

describe('priors — uma pergunta choice', () => {
  it('monta criteria com um rotulo por candidato e devolve a chave escolhida', async () => {
    ai.handler = (args) => {
      const criteria = args.questions['pick']?.criteria as Record<string, string>;
      const chosen = Object.entries(criteria).find(([, label]) => label === 'acao-2')?.[0];
      return { answers: { pick: { choice: chosen } }, usage };
    };

    const result = await createJevEvaluator().priors({
      state: { a: 1 },
      question: 'qual?',
      candidates: candidates(4),
    });

    expect(ai.calls).toHaveLength(1);
    const call = ai.calls[0] as EvalArgs;
    expect(call.questions['pick']?.type).toBe('choice');
    expect(call.questions['pick']?.instructions).toBe('qual?');
    const criteria = call.questions['pick']?.criteria as Record<string, string>;
    expect(Object.keys(criteria)).toEqual(['c0', 'c1', 'c2', 'c3']);
    expect(Object.values(criteria).sort()).toEqual(candidates(4).map((c) => c.label));
    // priors nao empacota slate: o estado vai como veio.
    expect(call.state).toEqual({ a: 1 });
    expect(result.top).toBe('k2');
  });

  it('sem probabilities, a massa vai para o escolhido mas ninguem fica em zero', async () => {
    ai.handler = (args) => {
      const criteria = args.questions['pick']?.criteria as Record<string, string>;
      const chosen = Object.entries(criteria).find(([, label]) => label === 'acao-1')?.[0];
      return { answers: { pick: { choice: chosen } }, usage };
    };

    const result = await createJevEvaluator().priors({
      state: 's',
      question: 'qual?',
      candidates: candidates(3),
    });

    const values = Object.values(result.distribution);
    expect(values.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(values.every((v) => v > 0)).toBe(true);
    expect(result.distribution['k1']).toBeGreaterThan(result.distribution['k0'] as number);
    expect(result.top).toBe('k1');
  });

  it('com probabilities, a distribuicao normaliza e respeita a ordem relativa', async () => {
    ai.handler = (args) => {
      const criteria = args.questions['pick']?.criteria as Record<string, string>;
      const probabilities: Record<string, number> = {};
      for (const [ref, label] of Object.entries(criteria)) {
        // Pesos nao normalizados de proposito: normalizar e trabalho do adaptador.
        probabilities[ref] = indexOfLabel(label) + 1;
      }
      const chosen = Object.entries(criteria).find(([, label]) => label === 'acao-3')?.[0];
      return { answers: { pick: { choice: chosen, probabilities } }, usage };
    };

    const result = await createJevEvaluator().priors({
      state: 's',
      question: 'qual?',
      candidates: candidates(4),
    });

    expect(Object.values(result.distribution).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(result.distribution['k3']).toBeGreaterThan(result.distribution['k2'] as number);
    expect(result.distribution['k2']).toBeGreaterThan(result.distribution['k1'] as number);
    expect(result.distribution['k1']).toBeGreaterThan(result.distribution['k0'] as number);
  });

  it('peso negativo ou nao-numerico nao contamina a distribuicao', async () => {
    ai.handler = (args) => {
      const criteria = args.questions['pick']?.criteria as Record<string, string>;
      const probabilities: Record<string, unknown> = {};
      for (const [ref, label] of Object.entries(criteria)) {
        probabilities[ref] = label === 'acao-0' ? -5 : label === 'acao-1' ? 'muito' : 1;
      }
      return { answers: { pick: { choice: 'c0', probabilities } }, usage };
    };

    const result = await createJevEvaluator().priors({
      state: 's',
      question: 'q',
      candidates: candidates(3),
    });

    const values = Object.values(result.distribution);
    expect(values.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
    expect(values.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(result.distribution['k2']).toBeGreaterThan(result.distribution['k0'] as number);
  });

  it('debiasPasses 2 faz a media entre as duas ordens', async () => {
    let pass = 0;
    ai.handler = (args) => {
      const criteria = args.questions['pick']?.criteria as Record<string, string>;
      const favored = pass++ === 0 ? 'acao-0' : 'acao-1';
      const probabilities: Record<string, number> = {};
      for (const [ref, label] of Object.entries(criteria)) {
        probabilities[ref] = label === favored ? 0.9 : 0.05;
      }
      const chosen = Object.entries(criteria).find(([, label]) => label === favored)?.[0];
      return { answers: { pick: { choice: chosen, probabilities } }, usage };
    };

    const result = await createJevEvaluator({ debiasPasses: 2 }).priors({
      state: 's',
      question: 'qual?',
      candidates: candidates(3),
    });

    expect(ai.calls).toHaveLength(2);
    expect(result.calls).toBe(2);
    // As duas favorecidas empatam na media; a terceira fica claramente atras.
    expect(result.distribution['k0']).toBeCloseTo(result.distribution['k1'] as number, 10);
    expect(result.distribution['k0']).toBeGreaterThan(result.distribution['k2'] as number);
    // `top` e o argmax DECLARADO na primeira passada, nao o da media.
    expect(result.top).toBe('k0');
  });

  it('resposta vazia vira uniforme em vez de NaN', async () => {
    ai.handler = () => ({ answers: {}, usage });
    const result = await createJevEvaluator().priors({
      state: 's',
      question: 'q',
      candidates: candidates(4),
    });
    const values = Object.values(result.distribution);
    expect(values.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    for (const value of values) expect(value).toBeCloseTo(0.25, 10);
    expect(result.top).toBe('k0');
  });
});

describe('value — uma pergunta score', () => {
  const levels = ['ruim', 'razoavel', 'bom', 'otimo'];

  it('passa a rubrica como criteria e normaliza por (niveis - 1)', async () => {
    ai.handler = () => ({ answers: { v: { score: 1.5 } }, usage });
    const result = await createJevEvaluator().value({
      state: { s: 1 },
      question: 'quao perto?',
      levels,
    });
    const call = ai.calls[0] as EvalArgs;
    expect(call.questions['v']?.type).toBe('score');
    expect(call.questions['v']?.criteria).toEqual(levels);
    expect(call.state).toEqual({ s: 1 });
    expect(result.raw).toBeCloseTo(1.5, 10);
    expect(result.value).toBeCloseTo(0.5, 10);
    expect(result.calls).toBe(1);
  });

  it('os extremos da rubrica viram 0 e 1', async () => {
    ai.handler = () => ({ answers: { v: { score: 3 } }, usage });
    expect((await createJevEvaluator().value({ state: 's', question: 'q', levels })).value).toBe(1);
    ai.handler = () => ({ answers: { v: { score: 0 } }, usage });
    expect((await createJevEvaluator().value({ state: 's', question: 'q', levels })).value).toBe(0);
  });

  it('score fora da faixa e recortado; ausente cai no meio', async () => {
    ai.handler = () => ({ answers: { v: { score: 99 } }, usage });
    const high = await createJevEvaluator().value({ state: 's', question: 'q', levels });
    expect(high.value).toBe(1);
    expect(high.raw).toBe(3);

    ai.handler = () => ({ answers: { v: { score: -4 } }, usage });
    expect((await createJevEvaluator().value({ state: 's', question: 'q', levels })).value).toBe(0);

    ai.handler = () => ({ answers: {}, usage });
    const missing = await createJevEvaluator().value({ state: 's', question: 'q', levels });
    expect(missing.value).toBeCloseTo(0.5, 10);
  });

  it('rubrica com menos de dois niveis e recusada antes de gastar chamada', async () => {
    await expect(
      createJevEvaluator().value({ state: 's', question: 'q', levels: ['unico'] }),
    ).rejects.toThrow(/rubrica/);
    expect(ai.calls).toHaveLength(0);
  });
});

describe('argumentos da chamada', () => {
  beforeEach(() => {
    ai.handler = () => ({ answers: {}, usage });
  });

  it('zeroDataRetention vai ligado por padrao e pode ser desligado', async () => {
    await createJevEvaluator().priors({ state: 's', question: 'q', candidates: candidates(2) });
    expect((ai.calls[0] as EvalArgs).providerOptions?.gateway?.zeroDataRetention).toBe(true);

    ai.calls.length = 0;
    await createJevEvaluator({ zeroDataRetention: false }).priors({
      state: 's',
      question: 'q',
      candidates: candidates(2),
    });
    expect((ai.calls[0] as EvalArgs).providerOptions).toBeUndefined();
  });

  it('o modelo padrao e typesafe-ai/jev e pode ser trocado', async () => {
    const standard = createJevEvaluator();
    expect(standard.id).toBe('jev:typesafe-ai/jev');
    await standard.priors({ state: 's', question: 'q', candidates: candidates(2) });
    expect((ai.calls[0] as EvalArgs).model).toBe('typesafe-ai/jev');

    ai.calls.length = 0;
    const custom = createJevEvaluator({ model: 'typesafe-ai/jev-latest' });
    expect(custom.id).toBe('jev:typesafe-ai/jev-latest');
    await custom.priors({ state: 's', question: 'q', candidates: candidates(2) });
    expect((ai.calls[0] as EvalArgs).model).toBe('typesafe-ai/jev-latest');
  });

  it('maxRetries tem default 2 e abortSignal chega ao SDK', async () => {
    await createJevEvaluator().priors({ state: 's', question: 'q', candidates: candidates(2) });
    expect((ai.calls[0] as EvalArgs).maxRetries).toBe(2);
    expect((ai.calls[0] as EvalArgs).abortSignal).toBeUndefined();

    ai.calls.length = 0;
    const controller = new AbortController();
    await createJevEvaluator({ maxRetries: 5, abortSignal: controller.signal }).priors({
      state: 's',
      question: 'q',
      candidates: candidates(2),
    });
    expect((ai.calls[0] as EvalArgs).maxRetries).toBe(5);
    expect((ai.calls[0] as EvalArgs).abortSignal).toBe(controller.signal);
  });

  it('nenhuma pergunta usa tipo fora de boolean, choice ou score', async () => {
    const evaluator = createJevEvaluator();
    await evaluator.screen({ state: 's', question: 'q', candidates: candidates(3) });
    await evaluator.priors({ state: 's', question: 'q', candidates: candidates(3) });
    await evaluator.value({ state: 's', question: 'q', levels: ['a', 'b'] });
    const types = ai.calls.flatMap((c) => Object.values(c.questions).map((q) => q.type));
    expect(new Set(types)).toEqual(new Set(['boolean', 'choice', 'score']));
  });
});

describe('credenciais', () => {
  it('reconhece qualquer uma das duas chaves', () => {
    expect(jevCredentialsPresent({})).toBe(false);
    expect(jevCredentialsPresent({ AI_GATEWAY_API_KEY: 'x' })).toBe(true);
    expect(jevCredentialsPresent({ TYPESAFE_AI_API_KEY: 'x' })).toBe(true);
  });

  it('variavel DECLARADA e vazia nao e credencial', () => {
    // .env.example distribui as duas vazias: e o caso comum, nao o exotico.
    expect(jevCredentialsPresent({ AI_GATEWAY_API_KEY: '' })).toBe(false);
    expect(jevCredentialsPresent({ AI_GATEWAY_API_KEY: '   ' })).toBe(false);
    expect(resolveJevCredential({ AI_GATEWAY_API_KEY: '' })).toBeNull();
  });

  it('gateway vazio nao engole a chave do alias', () => {
    // O bug do `??`: string vazia nao e null, entao o fallback nunca acontecia.
    const found = resolveJevCredential({ AI_GATEWAY_API_KEY: '', TYPESAFE_AI_API_KEY: 'k' });
    expect(found).toEqual({ key: 'k', source: 'TYPESAFE_AI_API_KEY' });
    expect(jevCredentialsPresent({ AI_GATEWAY_API_KEY: '', TYPESAFE_AI_API_KEY: 'k' })).toBe(true);
  });

  it('o gateway ganha do alias quando as duas tem valor', () => {
    const found = resolveJevCredential({ AI_GATEWAY_API_KEY: 'g', TYPESAFE_AI_API_KEY: 'k' });
    expect(found).toEqual({ key: 'g', source: 'AI_GATEWAY_API_KEY' });
  });

  it('a chave do alias vai parar sob o nome que o SDK le', async () => {
    // Sem esta ponte a guarda fica verde e o servidor responde 401: o provider
    // do Gateway le so AI_GATEWAY_API_KEY.
    const saved = {
      gateway: process.env['AI_GATEWAY_API_KEY'],
      alias: process.env['TYPESAFE_AI_API_KEY'],
    };
    const restore = (name: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    delete process.env['AI_GATEWAY_API_KEY'];
    process.env['TYPESAFE_AI_API_KEY'] = 'chave-do-alias';
    try {
      createJevEvaluator();
      expect(process.env['AI_GATEWAY_API_KEY']).toBe('chave-do-alias');
    } finally {
      restore('AI_GATEWAY_API_KEY', saved.gateway);
      restore('TYPESAFE_AI_API_KEY', saved.alias);
    }
  });
});
