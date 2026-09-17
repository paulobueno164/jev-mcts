import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { digest } from '../core/hash.js';
import { EMPTY_USAGE } from './evaluator.js';
import type {
  Evaluator,
  PriorsInput,
  PriorsResult,
  ScreenInput,
  ScreenResult,
  ValueInput,
  ValueResult,
} from './evaluator.js';

type Entry = { screen?: ScreenResult; priors?: PriorsResult; value?: ValueResult };

export interface CacheStats {
  hits: number;
  misses: number;
  entries: number;
}

export interface CachingEvaluator extends Evaluator {
  readonly stats: CacheStats;
  save(path: string): void;
  dump(): Record<string, Entry>;
}

/**
 * Jev e uma funcao pura de (modelo, estado, perguntas). Memorizar por conteudo
 * torna re-execucao e replay gratuitos, e torna o custo de uma corrida um numero
 * reproduzivel em vez de um sorteio.
 */
export function withCache(inner: Evaluator, seed?: Record<string, Entry>): CachingEvaluator {
  const store = new Map<string, Entry>(Object.entries(seed ?? {}));
  const stats: CacheStats = { hits: 0, misses: 0, entries: store.size };

  const key = (method: string, input: unknown): string => digest({ id: inner.id, method, input });

  const zeroCost = <T extends { usage: unknown; calls: number }>(result: T): T => ({
    ...result,
    usage: EMPTY_USAGE,
    calls: 0,
  });

  return {
    id: `cache(${inner.id})`,
    stats,
    async screen(input: ScreenInput): Promise<ScreenResult> {
      const k = key('screen', input);
      const hit = store.get(k)?.screen;
      if (hit) {
        stats.hits++;
        return zeroCost(hit);
      }
      stats.misses++;
      const result = await inner.screen(input);
      store.set(k, { ...store.get(k), screen: result });
      stats.entries = store.size;
      return result;
    },
    async priors(input: PriorsInput): Promise<PriorsResult> {
      const k = key('priors', input);
      const hit = store.get(k)?.priors;
      if (hit) {
        stats.hits++;
        return zeroCost(hit);
      }
      stats.misses++;
      const result = await inner.priors(input);
      store.set(k, { ...store.get(k), priors: result });
      stats.entries = store.size;
      return result;
    },
    async value(input: ValueInput): Promise<ValueResult> {
      const k = key('value', input);
      const hit = store.get(k)?.value;
      if (hit) {
        stats.hits++;
        return zeroCost(hit);
      }
      stats.misses++;
      const result = await inner.value(input);
      store.set(k, { ...store.get(k), value: result });
      stats.entries = store.size;
      return result;
    },
    dump: () => Object.fromEntries(store),
    save(path: string) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(Object.fromEntries(store), null, 2), 'utf8');
    },
  };
}

export function loadCache(path: string): Record<string, Entry> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, Entry>;
}

/**
 * Avaliador de replay: so serve o que ja esta no cache. Um miss significa que a
 * corrida divergiu da gravada, e o replay falha alto em vez de gastar rede e
 * fingir que reproduziu.
 */
export function replayOnly(entries: Record<string, Entry>, id = 'jev'): Evaluator {
  const store = new Map<string, Entry>(Object.entries(entries));
  const get = <K extends keyof Entry>(method: K, input: unknown): NonNullable<Entry[K]> => {
    const k = digest({ id, method, input });
    const hit = store.get(k)?.[method];
    if (!hit) {
      throw new Error(
        `replay divergiu: nenhuma avaliacao gravada para ${String(method)}@${k}. ` +
          'A corrida atual pediu algo que a gravada nao pediu.',
      );
    }
    return hit as NonNullable<Entry[K]>;
  };
  return {
    id: `replay(${id})`,
    async screen(input) {
      return { ...get('screen', input), usage: EMPTY_USAGE, calls: 0 };
    },
    async priors(input) {
      return { ...get('priors', input), usage: EMPTY_USAGE, calls: 0 };
    },
    async value(input) {
      return { ...get('value', input), usage: EMPTY_USAGE, calls: 0 };
    },
  };
}
