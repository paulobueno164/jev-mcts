/**
 * PRNG determinista (mulberry32). Toda aleatoriedade da busca passa por aqui:
 * mesma seed, mesma arvore, mesmo replay. Math.random e proibido no src/.
 */
export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  shuffled<T>(items: readonly T[]): T[];
  fork(tag: string): Rng;
}

export function makeRng(seed: number | string): Rng {
  let s = typeof seed === 'number' ? seed >>> 0 : strHash(seed);
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (maxExclusive) => (maxExclusive <= 0 ? 0 : Math.floor(next() * maxExclusive)),
    pick: (items) => {
      if (items.length === 0) throw new Error('rng.pick: lista vazia');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    shuffled: (items) => {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const a = out[i] as (typeof out)[number];
        const b = out[j] as (typeof out)[number];
        out[i] = b;
        out[j] = a;
      }
      return out;
    },
    fork: (tag) => makeRng((s ^ strHash(tag)) >>> 0),
  };
  return rng;
}

export function strHash(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
