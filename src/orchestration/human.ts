import type { Decision } from '../core/types.js';
import type { GateReason } from './gates.js';

export interface HumanRequest {
  readonly step: number;
  readonly goal: string;
  readonly stateView: string;
  readonly decision: Decision;
  readonly reasons: readonly GateReason[];
  /** Custo ja gasto na busca que produziu esta proposta. */
  readonly spent: { readonly calls: number; readonly usd: number; readonly wallMs: number };
}

export type HumanDecision =
  | { readonly kind: 'approve'; readonly note?: string }
  | { readonly kind: 'reject'; readonly note?: string }
  | { readonly kind: 'choose'; readonly key: string; readonly note?: string }
  | { readonly kind: 'amend'; readonly instruction: string }
  | { readonly kind: 'abort'; readonly note?: string };

export interface HumanPort {
  readonly id: string;
  decide(request: HumanRequest): Promise<HumanDecision>;
}

/**
 * Default de ambiente nao interativo: escalar significa PARAR.
 * Nunca significa seguir em frente porque nao havia ninguem para perguntar.
 */
export function haltingPort(): HumanPort {
  return {
    id: 'halting',
    async decide(request) {
      return {
        kind: 'abort',
        note: `sem porta humana disponivel; ${request.reasons.length} motivo(s) de escalonamento`,
      };
    },
  };
}

/** Porta roteirizada: testes e replay. */
export function scriptedPort(script: readonly HumanDecision[], id = 'scripted'): HumanPort {
  let i = 0;
  return {
    id,
    async decide() {
      const next = script[i];
      i += 1;
      return next ?? { kind: 'abort', note: 'roteiro humano esgotado' };
    },
  };
}

/**
 * Aprovacao automatica. Existe so para medir o custo de NAO ter humano no laco,
 * e por isso recusa acoes irreversiveis mesmo assim.
 */
export function autoApprovePort(): HumanPort {
  return {
    id: 'auto-approve(inseguro)',
    async decide(request) {
      if (request.decision.action.risk === 'irreversible') {
        return { kind: 'abort', note: 'auto-approve nao aprova acao irreversivel' };
      }
      return { kind: 'approve', note: 'aprovado sem humano (modo de medicao)' };
    },
  };
}

function formatRequest(request: HumanRequest): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('─'.repeat(72));
  lines.push(`PASSO ${request.step} — decisao escalada para voce`);
  lines.push(`objetivo : ${request.goal}`);
  lines.push('');
  lines.push(request.stateView);
  lines.push('');
  lines.push(`proposta : ${request.decision.action.label}`);
  lines.push(
    `           risco=${request.decision.action.risk}  visitas=${request.decision.visits}  ` +
      `valor=${request.decision.meanValue.toFixed(3)}  margem=${request.decision.margin.toFixed(3)}`,
  );
  lines.push(
    `           valor obtido por: ${request.decision.valueSource}` +
      (request.decision.confidence !== undefined
        ? `  confianca=${request.decision.confidence.toFixed(3)}`
        : '  confianca=nao aferida'),
  );
  lines.push('');
  lines.push('por que parou aqui:');
  for (const reason of request.reasons) {
    const numbers =
      reason.observed !== undefined
        ? ` (observado ${reason.observed.toFixed(3)}${
            reason.threshold !== undefined ? `, corte ${reason.threshold.toFixed(3)}` : ''
          })`
        : '';
    lines.push(`  - [${reason.code}] ${reason.detail}${numbers}`);
  }
  lines.push('');
  lines.push('alternativas ordenadas pela busca:');
  request.decision.ranking.slice(0, 6).forEach((entry, i) => {
    lines.push(
      `  ${i + 1}. ${entry.key.padEnd(24)} visitas=${String(entry.visits).padStart(4)}  ` +
        `valor=${entry.meanValue.toFixed(3)}  prior=${entry.prior.toFixed(3)}  ${entry.label}`,
    );
  });
  lines.push('');
  lines.push(
    `gasto ate aqui: ${request.spent.calls} chamadas, ` +
      `US$ ${request.spent.usd.toFixed(6)}, ${request.spent.wallMs} ms`,
  );
  lines.push('─'.repeat(72));
  lines.push('[a]provar  [r]ecusar  [n]<numero> escolher outra  [e]<texto> emendar  [x] abortar');
  return lines.join('\n');
}

/** Porta interativa de terminal. */
export function cliPort(): HumanPort {
  return {
    id: 'cli',
    async decide(request) {
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        process.stdout.write(`${formatRequest(request)}\n`);
        for (;;) {
          const answer = (await rl.question('> ')).trim();
          const head = answer.slice(0, 1).toLowerCase();
          const tail = answer.slice(1).trim();
          if (head === 'a') return { kind: 'approve' };
          if (head === 'r') return { kind: 'reject', ...(tail ? { note: tail } : {}) };
          if (head === 'x') return { kind: 'abort', ...(tail ? { note: tail } : {}) };
          if (head === 'e' && tail) return { kind: 'amend', instruction: tail };
          if (head === 'n') {
            const index = Number.parseInt(tail, 10) - 1;
            const chosen = request.decision.ranking[index];
            if (chosen) return { kind: 'choose', key: chosen.key };
            process.stdout.write('numero fora da lista\n');
            continue;
          }
          process.stdout.write('resposta nao reconhecida\n');
        }
      } finally {
        rl.close();
      }
    },
  };
}

export { formatRequest as formatHumanRequest };
