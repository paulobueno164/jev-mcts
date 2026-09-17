import { describe, expect, it } from 'vitest';
import { normalizeDistribution } from '../src/evaluator/evaluator.js';
import { createScriptedEvaluator } from '../src/evaluator/scripted.js';
import { replayOnly, withCache } from '../src/evaluator/cache.js';
import {
  calibrate,
  fitCalibration,
  identityCalibration,
  spearman,
} from '../src/evaluator/calibration.js';

const candidates = [
  { key: 'a', label: 'acao A' },
  { key: 'b', label: 'acao B' },
];

describe('normalizeDistribution', () => {
  it('soma 1 e mantem a ordem relativa', () => {
    const d = normalizeDistribution({ a: 3, b: 1 }, ['a', 'b']);
    expect(d['a']! + d['b']!).toBeCloseTo(1, 10);
    expect(d['a']!).toBeGreaterThan(d['b']!);
  });

  it('pesos todos zerados viram uniforme, nunca NaN', () => {
    const d = normalizeDistribution({ a: 0, b: 0 }, ['a', 'b']);
    expect(d['a']).toBeCloseTo(0.5, 10);
    expect(Number.isNaN(d['b'] as number)).toBe(false);
  });

  it('nenhuma chave recebe massa zero (suavizacao)', () => {
    const d = normalizeDistribution({ a: 100, b: 0 }, ['a', 'b']);
    expect(d['b']!).toBeGreaterThan(0);
  });
});

describe('cache', () => {
  it('o segundo pedido identico nao custa chamada nem token', async () => {
    const cached = withCache(createScriptedEvaluator({ id: 'fixo' }));
    const input = { state: { x: 1 }, question: 'q', candidates };
    const first = await cached.priors(input);
    const second = await cached.priors(input);
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(0);
    expect(second.usage.inputTokens).toBe(0);
    expect(second.distribution).toEqual(first.distribution);
    expect(cached.stats).toMatchObject({ hits: 1, misses: 1 });
  });

  it('entradas diferentes nao colidem', async () => {
    const cached = withCache(createScriptedEvaluator({ id: 'fixo' }));
    await cached.priors({ state: { x: 1 }, question: 'q', candidates });
    const other = await cached.priors({ state: { x: 2 }, question: 'q', candidates });
    expect(other.calls).toBe(1);
    expect(cached.stats.misses).toBe(2);
  });
});

describe('replayOnly', () => {
  it('serve o gravado sem custo', async () => {
    const cached = withCache(createScriptedEvaluator({ id: 'fixo' }));
    const input = { state: { x: 1 }, question: 'q', candidates };
    const live = await cached.priors(input);
    const replayed = await replayOnly(cached.dump(), 'fixo').priors(input);
    expect(replayed.distribution).toEqual(live.distribution);
    expect(replayed.calls).toBe(0);
  });

  it('derruba a corrida quando o replay pede algo que nao foi gravado', async () => {
    const cached = withCache(createScriptedEvaluator({ id: 'fixo' }));
    await cached.priors({ state: { x: 1 }, question: 'q', candidates });
    await expect(
      replayOnly(cached.dump(), 'fixo').priors({ state: { x: 9 }, question: 'q', candidates }),
    ).rejects.toThrow(/replay divergiu/);
  });
});

describe('calibration', () => {
  it('um preditor perfeito tem Brier 0 e acuracia 1', () => {
    const samples = [
      { p: 1, label: true },
      { p: 1, label: true },
      { p: 0, label: false },
      { p: 0, label: false },
    ];
    const fitted = fitCalibration(samples, 'm');
    expect(fitted.brier).toBeCloseTo(0, 10);
    expect(fitted.accuracy).toBeCloseTo(1, 10);
    expect(fitted.fitted).toBe(true);
  });

  it('um preditor que grita 0.9 e acerta metade fica exposto no ECE', () => {
    const samples = Array.from({ length: 100 }, (_, i) => ({ p: 0.9, label: i % 2 === 0 }));
    const fitted = fitCalibration(samples, 'm');
    expect(fitted.ece).toBeGreaterThan(0.35);
    // E a curva corrige a confianca crua para perto do acerto observado.
    expect(calibrate(fitted, 0.9)).toBeCloseTo(0.5, 2);
  });

  it('sem curva ajustada a confianca passa intacta', () => {
    expect(calibrate(identityCalibration('m'), 0.77)).toBeCloseTo(0.77, 10);
  });

  it('spearman detecta ordenacao invertida', () => {
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 6);
    expect(spearman([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(1, 6);
  });

  it('verdade constante devolve NaN em vez de um numero inventado', () => {
    expect(Number.isNaN(spearman([1, 1, 1], [1, 2, 3]))).toBe(true);
  });
});
