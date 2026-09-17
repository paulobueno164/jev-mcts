import type {
  Evaluator,
  PriorsInput,
  PriorsResult,
  ScreenInput,
  ScreenResult,
  ValueInput,
  ValueResult,
} from './evaluator.js';

/**
 * Lancada quando o avaliador continua indisponivel depois de todas as tentativas.
 *
 * Existe como tipo proprio porque o orquestrador precisa distinguir "o avaliador
 * caiu" de "o codigo tem um bug". A primeira e uma parada limpa com motivo; a
 * segunda tem que estourar.
 */
export class EvaluatorUnavailableError extends Error {
  readonly attempts: number;
  readonly lastError: unknown;

  constructor(id: string, attempts: number, lastError: unknown) {
    const detalhe = lastError instanceof Error ? lastError.message : String(lastError);
    super(`avaliador "${id}" indisponivel depois de ${attempts} tentativa(s): ${detalhe}`);
    this.name = 'EvaluatorUnavailableError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

export interface RetryOptions {
  /** Quantas vezes tentar no total, contando a primeira. Default 4. */
  readonly attempts?: number;
  /** Espera da primeira repeticao, dobrada a cada falha. Default 2000 ms. */
  readonly baseDelayMs?: number;
  /** Teto da espera. Default 30 s. */
  readonly maxDelayMs?: number;
  readonly onRetry?: (info: { method: string; attempt: number; delayMs: number; error: unknown }) => void;
  /** Injetavel para o teste nao dormir de verdade. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const TRANSIENTES = [
  'rate limit',
  'rate_limit',
  'ratelimit',
  'too many requests',
  'timeout',
  'timed out',
  'econnreset',
  'econnrefused',
  'etimedout',
  'enotfound',
  'socket hang up',
  'fetch failed',
  'network',
  'service unavailable',
  'bad gateway',
  'internal server error',
  'overloaded',
];

/**
 * Se vale a pena tentar de novo.
 *
 * Um 429 ou uma queda de rede passam; um 401 de credencial errada nao — repetir
 * uma chave invalida quatro vezes so atrasa o diagnostico em vinte segundos.
 */
export function isTransient(error: unknown): boolean {
  if (error === null || error === undefined) return false;

  const status = (error as { statusCode?: unknown; status?: unknown }).statusCode
    ?? (error as { status?: unknown }).status;
  if (typeof status === 'number') {
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    if (status >= 400 && status <= 499) return false;
  }

  const retryable = (error as { isRetryable?: unknown }).isRetryable;
  if (retryable === true) return true;

  const texto = [
    (error as { name?: unknown }).name,
    (error as { type?: unknown }).type,
    (error as { message?: unknown }).message,
  ]
    .filter((p) => typeof p === 'string')
    .join(' ')
    .toLowerCase();
  if (TRANSIENTES.some((marca) => texto.includes(marca))) return true;

  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== error) return isTransient(cause);
  return false;
}

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Decora um avaliador com repeticao por backoff exponencial.
 *
 * O ponto nao e "tentar mais": e transformar uma excecao nao tratada, que mata a
 * corrida e leva o progresso junto, em UMA excecao tipada que o orquestrador sabe
 * converter em parada limpa. Uma corrida de 40 minutos nao pode morrer por um 429.
 *
 * Nao ha jitter de proposito: `Math.random` e proibido em `src/` e uma espera que
 * muda a cada corrida quebraria a reprodutibilidade do journal.
 */
export function withRetry(inner: Evaluator, options: RetryOptions = {}): Evaluator {
  const attempts = Math.max(1, options.attempts ?? 4);
  const base = options.baseDelayMs ?? 2000;
  const teto = options.maxDelayMs ?? 30_000;
  const sleep = options.sleep ?? dormir;

  async function tentar<T>(method: string, call: () => Promise<T>): Promise<T> {
    let ultimo: unknown = null;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await call();
      } catch (error) {
        ultimo = error;
        if (!isTransient(error) || i === attempts) break;
        const delayMs = Math.min(teto, base * 2 ** (i - 1));
        options.onRetry?.({ method, attempt: i, delayMs, error });
        await sleep(delayMs);
      }
    }
    throw new EvaluatorUnavailableError(inner.id, attempts, ultimo);
  }

  return {
    id: `retry(${inner.id})`,
    screen: (input: ScreenInput): Promise<ScreenResult> => tentar('screen', () => inner.screen(input)),
    priors: (input: PriorsInput): Promise<PriorsResult> => tentar('priors', () => inner.priors(input)),
    value: (input: ValueInput): Promise<ValueResult> => tentar('value', () => inner.value(input)),
  };
}
