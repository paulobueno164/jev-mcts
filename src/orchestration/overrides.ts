import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { digest } from '../core/hash.js';
import type { Json } from '../core/types.js';

export interface OverrideRecord {
  readonly stateKey: string;
  banned: string[];
  forced?: string;
  notes: string[];
  updatedAt: string;
}

export interface OverrideStore {
  lookup(stateKey: string): OverrideRecord | undefined;
  ban(stateKey: string, actionKey: string, note?: string): void;
  force(stateKey: string, actionKey: string, note?: string): void;
  /** Pesos a injetar no prior da raiz, ou undefined se nada foi decidido aqui. */
  priorFor(stateKey: string): Record<string, number> | undefined;
  entries(): readonly OverrideRecord[];
  save(path: string): void;
}

/** Assinatura de um estado + o leque de acoes dele. Duas corridas no mesmo ponto batem. */
export function stateKeyOf(stateView: string | Json, actionKeys: readonly string[]): string {
  return digest({ state: stateView, actions: [...actionKeys].sort() });
}

/**
 * Memoria das decisoes humanas.
 *
 * Um "recusar" nao morre no passo em que aconteceu: ele vira prior duro para o
 * mesmo estado em qualquer corrida futura. E assim que o humano ensina a busca
 * em vez de responder a mesma pergunta toda vez.
 */
export function createOverrideStore(seed: readonly OverrideRecord[] = []): OverrideStore {
  const store = new Map<string, OverrideRecord>(seed.map((r) => [r.stateKey, r]));

  const touch = (stateKey: string): OverrideRecord => {
    const existing = store.get(stateKey);
    if (existing) return existing;
    const fresh: OverrideRecord = {
      stateKey,
      banned: [],
      notes: [],
      updatedAt: new Date().toISOString(),
    };
    store.set(stateKey, fresh);
    return fresh;
  };

  return {
    lookup: (stateKey) => store.get(stateKey),
    ban(stateKey, actionKey, note) {
      const record = touch(stateKey);
      if (!record.banned.includes(actionKey)) record.banned.push(actionKey);
      if (record.forced === actionKey) delete record.forced;
      record.notes.push(`recusou ${actionKey}${note ? `: ${note}` : ''}`);
      record.updatedAt = new Date().toISOString();
    },
    force(stateKey, actionKey, note) {
      const record = touch(stateKey);
      record.forced = actionKey;
      record.banned = record.banned.filter((k) => k !== actionKey);
      record.notes.push(`aprovou ${actionKey}${note ? `: ${note}` : ''}`);
      record.updatedAt = new Date().toISOString();
    },
    priorFor(stateKey) {
      const record = store.get(stateKey);
      if (!record) return undefined;
      if (record.banned.length === 0 && !record.forced) return undefined;
      const weights: Record<string, number> = {};
      for (const key of record.banned) weights[key] = 1e-4;
      if (record.forced) weights[record.forced] = 5;
      return weights;
    },
    entries: () => [...store.values()],
    save(path) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify([...store.values()], null, 2), 'utf8');
    },
  };
}

export function loadOverrideStore(path: string): OverrideStore {
  if (!existsSync(path)) return createOverrideStore();
  return createOverrideStore(JSON.parse(readFileSync(path, 'utf8')) as OverrideRecord[]);
}
