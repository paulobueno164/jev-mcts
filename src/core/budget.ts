export interface BudgetLimits {
  /** Numero maximo de chamadas ao avaliador. */
  readonly calls?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly wallMs?: number;
  readonly usd?: number;
}

export interface Pricing {
  /** USD por 1M tokens de entrada. Jev no AI Gateway: 42 USD/1e9 = 0.042 USD/1e6. */
  readonly inputPerMTok: number;
  /** Preco de saida nao publicado separadamente; assume igual ao de entrada. */
  readonly outputPerMTok: number;
}

export const JEV_PRICING: Pricing = Object.freeze({
  inputPerMTok: 0.042,
  outputPerMTok: 0.042,
});

export interface BudgetSnapshot {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly wallMs: number;
  readonly usd: number;
}

export type BudgetBreach =
  | 'calls'
  | 'inputTokens'
  | 'outputTokens'
  | 'totalTokens'
  | 'wallMs'
  | 'usd';

export class BudgetExceededError extends Error {
  constructor(
    readonly breach: BudgetBreach,
    readonly snapshot: BudgetSnapshot,
    readonly limits: BudgetLimits,
  ) {
    super(`orcamento estourado em "${breach}"`);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Contador de custo da busca. A busca consulta `exceeded()` antes de cada
 * chamada e para limpa; nunca ha um estouro silencioso.
 */
export class Budget {
  private calls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private readonly startedAt: number;

  constructor(
    readonly limits: BudgetLimits = {},
    readonly pricing: Pricing = JEV_PRICING,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.startedAt = now();
  }

  record(usage: { inputTokens?: number; outputTokens?: number }): void {
    this.calls += 1;
    this.inputTokens += usage.inputTokens ?? 0;
    this.outputTokens += usage.outputTokens ?? 0;
  }

  snapshot(): BudgetSnapshot {
    const totalTokens = this.inputTokens + this.outputTokens;
    const usd =
      (this.inputTokens / 1e6) * this.pricing.inputPerMTok +
      (this.outputTokens / 1e6) * this.pricing.outputPerMTok;
    return {
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens,
      wallMs: this.now() - this.startedAt,
      usd,
    };
  }

  /** Qual limite ja estourou, ou null. */
  exceeded(): BudgetBreach | null {
    const s = this.snapshot();
    const l = this.limits;
    if (l.calls !== undefined && s.calls >= l.calls) return 'calls';
    if (l.inputTokens !== undefined && s.inputTokens >= l.inputTokens) return 'inputTokens';
    if (l.outputTokens !== undefined && s.outputTokens >= l.outputTokens) return 'outputTokens';
    if (l.totalTokens !== undefined && s.totalTokens >= l.totalTokens) return 'totalTokens';
    if (l.wallMs !== undefined && s.wallMs >= l.wallMs) return 'wallMs';
    if (l.usd !== undefined && s.usd >= l.usd) return 'usd';
    return null;
  }

  assertWithin(): void {
    const breach = this.exceeded();
    if (breach) throw new BudgetExceededError(breach, this.snapshot(), this.limits);
  }
}
