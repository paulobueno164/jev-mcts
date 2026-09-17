import { describe, expect, it } from 'vitest';
import { makeRng } from '../src/core/rng.js';
import { digest, stableStringify } from '../src/core/hash.js';
import { Budget, BudgetExceededError, JEV_PRICING } from '../src/core/budget.js';
import { createJournal } from '../src/core/journal.js';

describe('rng', () => {
  it('a mesma semente produz a mesma sequencia', () => {
    const a = makeRng('x');
    const b = makeRng('x');
    const seqA = Array.from({ length: 8 }, () => a.next());
    const seqB = Array.from({ length: 8 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('sementes diferentes divergem', () => {
    expect(makeRng('x').next()).not.toBe(makeRng('y').next());
  });

  it('shuffled preserva os elementos e e reproduzivel', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const first = makeRng(7).shuffled(items);
    const second = makeRng(7).shuffled(items);
    expect(first).toEqual(second);
    expect([...first].sort((a, b) => a - b)).toEqual(items);
  });

  it('fork deriva sequencias distintas e estaveis', () => {
    const base = () => makeRng('raiz').fork('a').next();
    expect(base()).toBe(base());
    expect(makeRng('raiz').fork('a').next()).not.toBe(makeRng('raiz').fork('b').next());
  });
});

describe('hash', () => {
  it('a ordem das chaves nao muda a serializacao', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(digest({ b: [1, { d: 4, c: 3 }] })).toBe(digest({ b: [1, { c: 3, d: 4 }] }));
  });

  it('conteudo diferente muda o digest', () => {
    expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }));
  });
});

describe('budget', () => {
  it('acusa o limite de chamadas', () => {
    const budget = new Budget({ calls: 2 });
    expect(budget.exceeded()).toBeNull();
    budget.record({ inputTokens: 10 });
    expect(budget.exceeded()).toBeNull();
    budget.record({ inputTokens: 10 });
    expect(budget.exceeded()).toBe('calls');
    expect(() => budget.assertWithin()).toThrow(BudgetExceededError);
  });

  it('preca a 42 USD por bilhao de tokens de entrada', () => {
    const budget = new Budget({}, JEV_PRICING);
    budget.record({ inputTokens: 1_000_000 });
    expect(budget.snapshot().usd).toBeCloseTo(0.042, 6);
  });

  it('o relogio e injetavel, entao wallMs e testavel sem esperar', () => {
    let now = 0;
    const budget = new Budget({ wallMs: 100 }, JEV_PRICING, () => now);
    expect(budget.exceeded()).toBeNull();
    now = 150;
    expect(budget.exceeded()).toBe('wallMs');
  });
});

describe('journal', () => {
  it('numera os eventos em sequencia', () => {
    const journal = createJournal(null);
    journal.write('run.start', { a: 1 });
    journal.write('act', { a: 2 });
    expect(journal.events().map((e) => e.seq)).toEqual([0, 1]);
    expect(journal.events().map((e) => e.type)).toEqual(['run.start', 'act']);
  });
});
