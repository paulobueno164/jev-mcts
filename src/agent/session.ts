import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WorkspaceState } from './workspace.js';

/**
 * A sessao e o que faz `jev build` ser RE-CHAMAVEL.
 *
 * Sem ela, cada invocacao comeca do zero: o estado morre com o processo e, pior,
 * as recusas do humano morrem junto — o agente proporia de novo, na chamada
 * seguinte, exatamente a acao que acabou de ser recusada. O arquivo de sessao
 * guarda o estado observado; as recusas ficam ao lado, no arquivo de overrides,
 * e as avaliacoes no de cache.
 */
export interface Session {
  readonly version: 1;
  readonly specPath: string;
  readonly goal: string;
  readonly state: WorkspaceState;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Quantas invocacoes de `jev build` ja tocaram esta sessao. */
  readonly runs: number;
  readonly lastStop: string;
}

export interface SessionPaths {
  readonly session: string;
  readonly overrides: string;
  readonly cache: string;
  readonly journal: string;
}

export function sessionPaths(sessionPath: string): SessionPaths {
  const base = sessionPath.replace(/\.json$/i, '');
  return {
    session: sessionPath,
    overrides: `${base}.overrides.json`,
    cache: `${base}.cache.json`,
    journal: `${base}.ndjson`,
  };
}

export function loadSession(path: string): Session | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Session;
  if (parsed.version !== 1) {
    throw new Error(`sessao em formato desconhecido (version=${String(parsed.version)}): ${path}`);
  }
  return parsed;
}

export function saveSession(path: string, session: Session): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
}

export function nextSession(
  previous: Session | null,
  fields: { specPath: string; goal: string; state: WorkspaceState; lastStop: string },
): Session {
  const now = new Date().toISOString();
  return {
    version: 1,
    specPath: fields.specPath,
    goal: fields.goal,
    state: fields.state,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    runs: (previous?.runs ?? 0) + 1,
    lastStop: fields.lastStop,
  };
}

/**
 * Primeiro indice livre para o journal desta invocacao.
 *
 * Nao da para derivar o nome do contador de corridas da sessao: uma invocacao
 * interrompida antes do `saveSession` nao incrementa o contador, mas deixa o
 * arquivo no disco — e a proxima colide. `createJournal` se recusa a reabrir um
 * journal existente (concatenar duas corridas quebraria o replay), entao quem
 * escolhe o nome tem de olhar o disco.
 */
export function nextJournalPath(journalPath: string, limit = 10_000): string {
  const base = journalPath.replace(/\.ndjson$/i, '');
  for (let i = 0; i < limit; i++) {
    const candidate = `${base}.${i}.ndjson`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`mais de ${limit} journals em ${base}.*.ndjson — limpe o diretorio`);
}
