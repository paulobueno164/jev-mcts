import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Json } from './types.js';

export type JournalEventType =
  | 'run.start'
  | 'eval.call'
  | 'search.done'
  | 'gate'
  | 'human.request'
  | 'human.decision'
  | 'act'
  | 'agent.run'
  | 'probe.observe'
  | 'budget.breach'
  | 'run.end';

export interface JournalEvent {
  readonly seq: number;
  readonly t: number;
  readonly type: JournalEventType;
  readonly data: Json;
}

export interface Journal {
  write(type: JournalEventType, data: Json): void;
  events(): readonly JournalEvent[];
  readonly path: string | null;
}

/**
 * Log append-only em NDJSON. E o unico registro do que a corrida decidiu e
 * com que numeros; `replayJournal` le esse arquivo e refaz a corrida sem rede.
 */
export function createJournal(path: string | null): Journal {
  const started = Date.now();
  const buffer: JournalEvent[] = [];
  let seq = 0;
  if (path) {
    // Append-only vale dentro de UMA corrida. Reabrir um journal existente
    // concatenaria duas corridas no mesmo arquivo e o replay compararia a
    // corrida atual com a soma das duas -- falha silenciosa, a pior especie.
    if (existsSync(path)) {
      throw new Error(`journal ja existe: ${path} — escolha outro caminho ou apague o arquivo`);
    }
    mkdirSync(dirname(path), { recursive: true });
  }
  return {
    path,
    write(type, data) {
      const event: JournalEvent = { seq: seq++, t: Date.now() - started, type, data };
      buffer.push(event);
      if (path) appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8');
    },
    events: () => buffer,
  };
}

export function readJournal(path: string): JournalEvent[] {
  if (!existsSync(path)) throw new Error(`journal inexistente: ${path}`);
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JournalEvent);
}
