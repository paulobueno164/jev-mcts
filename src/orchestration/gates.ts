import { RISK_ORDER, riskAtLeast, type Decision, type RiskClass } from '../core/types.js';
import type { SearchStats } from '../search/mcts.js';

export type GateCode =
  | 'no-decision'
  | 'irreversible-action'
  | 'risk-threshold'
  | 'low-confidence'
  | 'uncalibrated-confidence'
  | 'narrow-margin'
  | 'speculative-value'
  | 'budget-exhausted';

export interface GateReason {
  readonly code: GateCode;
  readonly detail: string;
  readonly observed?: number;
  readonly threshold?: number;
}

export interface GateVerdict {
  readonly outcome: 'proceed' | 'escalate';
  readonly reasons: readonly GateReason[];
}

export interface GateConfig {
  /** Confianca calibrada minima para agir sozinho. */
  readonly minConfidence: number;
  /** Corte usado enquanto NAO ha curva de calibracao ajustada. Mais alto de proposito. */
  readonly minConfidenceUncalibrated: number;
  /** Margem minima de visitas entre 1o e 2o. Baixa = a busca esta dividida. */
  readonly minMargin: number;
  /** A partir desta classe de risco, sempre pergunta. */
  readonly escalateAtOrAbove: RiskClass;
  /** Escalar quando o valor das folhas nao foi todo medido pelo ambiente. */
  readonly escalateOnSpeculativeValue: boolean;
  /**
   * Fracao minima de folhas MEDIDAS pelo ambiente para agir sozinho. O default
   * e 1: qualquer estimativa na arvore escala. Baixar isso e uma escolha do
   * operador, e o relatorio mostra a fracao observada ao lado.
   */
  readonly minGroundedFraction: number;
}

export const DEFAULT_GATES: GateConfig = Object.freeze({
  minConfidence: 0.7,
  minConfidenceUncalibrated: 0.9,
  minMargin: 0.15,
  escalateAtOrAbove: 'costly',
  escalateOnSpeculativeValue: true,
  minGroundedFraction: 1,
});

/**
 * O ponto onde o humano entra.
 *
 * Uma regra nao e configuravel e nao tem excecao: acao `irreversible` sempre
 * pergunta, por melhor que a busca ache que esta. Todas as outras sao limiares,
 * e todo limiar que disparou aparece no relatorio com o numero observado ao
 * lado -- nunca um "escalado" sem o motivo medido.
 */
export function applyGates(
  decision: Decision | null,
  stats: SearchStats,
  config: GateConfig = DEFAULT_GATES,
): GateVerdict {
  const reasons: GateReason[] = [];

  if (!decision) {
    return {
      outcome: 'escalate',
      reasons: [{ code: 'no-decision', detail: 'a busca nao produziu nenhuma acao selecionavel' }],
    };
  }

  if (decision.action.risk === 'irreversible') {
    reasons.push({
      code: 'irreversible-action',
      detail: `"${decision.action.label}" e irreversivel; aprovacao humana e obrigatoria`,
    });
  } else if (riskAtLeast(decision.action.risk, config.escalateAtOrAbove)) {
    reasons.push({
      code: 'risk-threshold',
      detail: `risco "${decision.action.risk}" atinge o limite "${config.escalateAtOrAbove}"`,
      observed: RISK_ORDER[decision.action.risk],
      threshold: RISK_ORDER[config.escalateAtOrAbove],
    });
  }

  const threshold = stats.calibrated ? config.minConfidence : config.minConfidenceUncalibrated;
  if (decision.confidence === undefined) {
    if (config.escalateOnSpeculativeValue && decision.speculative) {
      reasons.push({
        code: 'uncalibrated-confidence',
        detail: 'nenhuma triagem rodou: nao ha confianca aferida para esta decisao',
      });
    }
  } else if (decision.confidence < threshold) {
    reasons.push({
      code: stats.calibrated ? 'low-confidence' : 'uncalibrated-confidence',
      detail: stats.calibrated
        ? 'confianca calibrada abaixo do corte'
        : 'sem curva de calibracao ajustada, o corte aplicado e o estrito',
      observed: decision.confidence,
      threshold,
    });
  }

  if (decision.margin < config.minMargin) {
    reasons.push({
      code: 'narrow-margin',
      detail: 'a busca ficou dividida entre as duas primeiras acoes',
      observed: decision.margin,
      threshold: config.minMargin,
    });
  }

  if (config.escalateOnSpeculativeValue && decision.groundedFraction < config.minGroundedFraction) {
    const measured = decision.valueSources['grounded-reward'] + decision.valueSources['grounded-rollout'];
    const total = Object.values(decision.valueSources).reduce((sum, n) => sum + n, 0);
    reasons.push({
      code: 'speculative-value',
      detail:
        total === 0
          ? 'nenhuma folha chegou a ser avaliada'
          : `so ${measured} de ${total} folhas foram medidas pelo ambiente; o resto e estimativa`,
      observed: decision.groundedFraction,
      threshold: config.minGroundedFraction,
    });
  }

  if (stats.stoppedBy !== 'iterations') {
    reasons.push({
      code: 'budget-exhausted',
      detail: `a busca parou por "${stats.stoppedBy}" antes de esgotar as iteracoes`,
      observed: stats.iterations,
    });
  }

  return { outcome: reasons.length > 0 ? 'escalate' : 'proceed', reasons };
}
