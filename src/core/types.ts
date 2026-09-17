export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/**
 * Quao dificil e desfazer uma acao. E declarado pelo catalogo de acoes, nunca
 * inferido por modelo: um classificador nao decide o que e irreversivel.
 */
export type RiskClass = 'safe' | 'reversible' | 'costly' | 'irreversible';

export const RISK_ORDER: Readonly<Record<RiskClass, number>> = Object.freeze({
  safe: 0,
  reversible: 1,
  costly: 2,
  irreversible: 3,
});

export function riskAtLeast(a: RiskClass, b: RiskClass): boolean {
  return RISK_ORDER[a] >= RISK_ORDER[b];
}

export interface Action {
  /** Identificador estavel e unico entre irmaos. */
  readonly key: string;
  /** Uma linha que um humano (e o Jev) consegue ler sem contexto extra. */
  readonly label: string;
  readonly risk: RiskClass;
  readonly params?: Json;
}

/**
 * Como um valor de estado foi obtido. Vai no relatorio e no journal; e a
 * diferenca entre "medido" e "chutado", e o relatorio nunca esconde isso.
 */
export type ValueSource = 'grounded-rollout' | 'grounded-reward' | 'jev-score' | 'prior-only';

export interface ValueEstimate {
  /** Normalizado em [0,1]. 1 = melhor desfecho conhecido. */
  readonly value: number;
  readonly source: ValueSource;
  /** Confianca calibrada em [0,1], quando existe. undefined = nao aferida. */
  readonly confidence?: number;
}

export interface Decision {
  readonly action: Action;
  readonly visits: number;
  readonly meanValue: number;
  /** Fracao de visitas do 1o menos a do 2o. Baixo = a busca esta dividida. */
  readonly margin: number;
  /**
   * Procedencia PREDOMINANTE das folhas. E um resumo: leia `valueSources` e
   * `groundedFraction` antes de tratar uma decisao como medida.
   */
  readonly valueSource: ValueSource;
  /**
   * Quantas folhas vieram de cada procedencia. Uma busca mista existe, e um
   * rotulo unico esconderia que 188 de 200 folhas foram estimativa.
   */
  readonly valueSources: Readonly<Record<ValueSource, number>>;
  /** Fracao das folhas cujo valor foi MEDIDO pelo ambiente. 1 = tudo medido. */
  readonly groundedFraction: number;
  /** Confianca calibrada agregada; undefined quando nao ha calibracao carregada. */
  readonly confidence?: number;
  readonly speculative: boolean;
  readonly ranking: ReadonlyArray<{
    key: string;
    label: string;
    visits: number;
    meanValue: number;
    prior: number;
  }>;
}
