import { describe, expect, it } from 'vitest';
import type { Decision, RiskClass } from '../src/core/types.js';
import { applyGates, DEFAULT_GATES } from '../src/orchestration/gates.js';
import type { SearchStats } from '../src/search/mcts.js';

function decision(risk: RiskClass, over: Partial<Decision> = {}): Decision {
  return {
    action: { key: 'a', label: 'acao', risk },
    visits: 100,
    meanValue: 0.99,
    margin: 0.9,
    valueSource: 'grounded-rollout',
    valueSources: {
      'grounded-reward': 0,
      'grounded-rollout': 100,
      'jev-score': 0,
      'prior-only': 0,
    },
    groundedFraction: 1,
    confidence: 0.99,
    speculative: false,
    ranking: [{ key: 'a', label: 'acao', visits: 100, meanValue: 0.99, prior: 0.9 }],
    ...over,
  };
}

function stats(over: Partial<SearchStats> = {}): SearchStats {
  return {
    iterations: 200,
    nodes: 50,
    evaluatorCalls: 10,
    budget: { calls: 10, inputTokens: 0, outputTokens: 0, totalTokens: 0, wallMs: 5, usd: 0 },
    stoppedBy: 'iterations',
    depthCap: 24,
    depthCapClamped: false,
    calibrated: true,
    prunedByScreen: 0,
    ...over,
  };
}

describe('portoes', () => {
  it('uma decisao perfeita e de baixo risco passa sozinha', () => {
    const verdict = applyGates(decision('safe'), stats());
    expect(verdict.outcome).toBe('proceed');
    expect(verdict.reasons).toHaveLength(0);
  });

  it('acao irreversivel SEMPRE escala, por melhores que sejam os numeros', () => {
    const verdict = applyGates(decision('irreversible'), stats());
    expect(verdict.outcome).toBe('escalate');
    expect(verdict.reasons.map((r) => r.code)).toContain('irreversible-action');
  });

  it('a configuracao nao consegue desligar o portao do irreversivel', () => {
    const verdict = applyGates(
      decision('irreversible'),
      stats(),
      // Todos os limiares frouxos ao mesmo tempo.
      {
        minConfidence: 0,
        minConfidenceUncalibrated: 0,
        minMargin: 0,
        minGroundedFraction: 0,
        escalateAtOrAbove: 'irreversible',
        escalateOnSpeculativeValue: false,
      },
    );
    expect(verdict.outcome).toBe('escalate');
    expect(verdict.reasons.map((r) => r.code)).toContain('irreversible-action');
  });

  it('risco costly escala no limite padrao', () => {
    expect(applyGates(decision('costly'), stats()).outcome).toBe('escalate');
    expect(applyGates(decision('reversible'), stats()).outcome).toBe('proceed');
  });

  it('margem estreita escala e o motivo carrega o numero observado', () => {
    const verdict = applyGates(decision('safe', { margin: 0.02 }), stats());
    const reason = verdict.reasons.find((r) => r.code === 'narrow-margin');
    expect(reason?.observed).toBeCloseTo(0.02, 10);
    expect(reason?.threshold).toBeCloseTo(DEFAULT_GATES.minMargin, 10);
  });

  it('sem calibracao o corte de confianca aperta', () => {
    const d = decision('safe', { confidence: 0.8 });
    expect(applyGates(d, stats({ calibrated: true })).outcome).toBe('proceed');
    const strict = applyGates(d, stats({ calibrated: false }));
    expect(strict.outcome).toBe('escalate');
    expect(strict.reasons.map((r) => r.code)).toContain('uncalibrated-confidence');
  });

  it('valor estimado pelo avaliador escala quando o portao esta ligado', () => {
    const d = decision('safe', {
      valueSource: 'jev-score',
      valueSources: { 'grounded-reward': 0, 'grounded-rollout': 0, 'jev-score': 100, 'prior-only': 0 },
      groundedFraction: 0,
    });
    expect(applyGates(d, stats()).reasons.map((r) => r.code)).toContain('speculative-value');
    expect(
      applyGates(d, stats(), { ...DEFAULT_GATES, escalateOnSpeculativeValue: false }).outcome,
    ).toBe('proceed');
  });

  it('uma busca MISTA escala: uma folha medida nao compra o rotulo de medida', () => {
    // A regressao que este teste guarda: antes, uma unica folha com recompensa
    // carimbava a decisao inteira como "medida" e o portao nao disparava.
    const mixed = decision('safe', {
      valueSource: 'jev-score',
      valueSources: { 'grounded-reward': 3, 'grounded-rollout': 0, 'jev-score': 197, 'prior-only': 0 },
      groundedFraction: 3 / 200,
    });
    const verdict = applyGates(mixed, stats());
    const reason = verdict.reasons.find((r) => r.code === 'speculative-value');
    expect(verdict.outcome).toBe('escalate');
    expect(reason?.observed).toBeCloseTo(0.015, 6);
    expect(reason?.detail).toContain('3 de 200');
  });

  it('o operador pode baixar a exigencia, e o corte aplicado fica no motivo', () => {
    const mixed = decision('safe', {
      valueSources: { 'grounded-reward': 90, 'grounded-rollout': 0, 'jev-score': 10, 'prior-only': 0 },
      groundedFraction: 0.9,
    });
    expect(applyGates(mixed, stats()).outcome).toBe('escalate');
    expect(
      applyGates(mixed, stats(), { ...DEFAULT_GATES, minGroundedFraction: 0.8 }).outcome,
    ).toBe('proceed');
  });

  it('busca interrompida por orcamento escala', () => {
    const verdict = applyGates(decision('safe'), stats({ stoppedBy: 'wallMs' }));
    expect(verdict.reasons.map((r) => r.code)).toContain('budget-exhausted');
  });

  it('sem decisao, escala em vez de inventar uma acao', () => {
    const verdict = applyGates(null, stats());
    expect(verdict.outcome).toBe('escalate');
    expect(verdict.reasons.map((r) => r.code)).toEqual(['no-decision']);
  });
});
