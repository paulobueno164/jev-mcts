import type { Decision } from './core/types.js';
import type { RunResult } from './orchestration/orchestrator.js';

const SOURCE_LABEL: Record<string, string> = {
  'grounded-reward': 'recompensa do ambiente',
  'grounded-rollout': 'playout real ate o fim',
  'jev-score': 'nota do avaliador',
  'prior-only': 'nao avaliado',
};

/**
 * A linha de procedencia.
 *
 * Nunca um rotulo unico: uma busca mista existe, e "medido" ao lado de uma
 * decisao em que 188 de 200 folhas foram estimativa e a forma mais barata de
 * enganar quem le. O numerador e o denominador vao juntos, sempre.
 */
function provenanceLine(d: Decision): string {
  const measured = d.valueSources['grounded-reward'] + d.valueSources['grounded-rollout'];
  const estimated = d.valueSources['jev-score'];
  const unscored = d.valueSources['prior-only'];
  const total = measured + estimated + unscored;
  if (total === 0) return 'valor: nenhuma folha avaliada (busca interrompida antes da 1a iteracao)';
  const pct = (d.groundedFraction * 100).toFixed(0);
  if (measured === total) {
    return `valor: ${measured}/${total} folhas medidas (${SOURCE_LABEL[d.valueSource]})`;
  }
  if (measured === 0) {
    return `valor: 0/${total} folhas medidas — tudo estimado pelo avaliador, nada foi executado`;
  }
  return `valor: ${measured}/${total} folhas medidas (${pct}%) — ${estimated} estimadas pelo avaliador`;
}

const STOP_LABEL: Record<string, string> = {
  terminal: 'terminal (o ambiente considerou a tarefa concluida)',
  'max-steps': 'limite de passos',
  aborted: 'abortado pelo humano',
  blocked: 'bloqueado — so restavam acoes que o humano recusou',
};

/**
 * Relatorio de uma corrida.
 *
 * A regra: nenhuma linha pode deixar o leitor supor que algo foi medido quando
 * foi estimado. Toda proposta carrega a procedencia do seu valor, as propostas
 * recusadas aparecem (uma recusa e informacao, nao lixo) e o rodape diz quantas
 * decisoes vieram de cada lado.
 */
export function formatRun<S>(result: RunResult<S>): string {
  const lines: string[] = [];
  const p = result.provenance;

  lines.push('═'.repeat(74));
  lines.push(`objetivo : ${result.goal}`);
  lines.push(
    `ambiente : fidelidade=${p.fidelity}  teto de profundidade=${p.depthCap}` +
      (p.depthCapClamped ? ' (recortado por ser speculative)' : ''),
  );
  lines.push(
    `avaliador: calibracao=${p.calibrated ? 'ajustada' : 'AUSENTE (portoes no corte estrito)'}` +
      `  porta humana=${p.humanPort}`,
  );
  lines.push('─'.repeat(74));

  for (const step of result.steps) {
    for (const attempt of step.attempts) {
      const d = attempt.decision;
      const tag = `passo ${step.step}` + (step.attempts.length > 1 ? `.${attempt.attempt}` : '');
      if (!d) {
        lines.push(`${tag}: sem decisao — ${attempt.verdict.reasons.map((r) => r.code).join(', ')}`);
        continue;
      }
      const applied = step.applied !== null && attempt.human?.decision.kind !== 'reject';
      const via = attempt.human
        ? `humano:${attempt.human.decision.kind}`
        : applied
          ? 'autonomo'
          : 'nao aplicado';
      lines.push(
        `${tag} [${via}] ${d.action.key}` +
          `  risco=${d.action.risk}  visitas=${d.visits}  valor=${d.meanValue.toFixed(3)}` +
          `  margem=${d.margin.toFixed(3)}` +
          (d.confidence !== undefined ? `  conf=${d.confidence.toFixed(3)}` : '  conf=n/a'),
      );
      lines.push(`          ${provenanceLine(d)}`);
      if (attempt.verdict.reasons.length > 0) {
        lines.push(`          portao: ${attempt.verdict.reasons.map((r) => r.code).join(', ')}`);
      }
      const note = attempt.human?.decision;
      if (note && 'note' in note && note.note) {
        lines.push(`          humano: "${note.note}"`);
      }
    }
  }

  lines.push('─'.repeat(74));
  lines.push(`parou por : ${STOP_LABEL[result.stopped] ?? result.stopped}`);
  lines.push(
    `decisoes  : ${result.totals.autonomous} autonomas, ` +
      `${result.totals.escalations} escaladas ao humano, ` +
      `${result.totals.rejections} recusadas`,
  );
  const leaves = p.measuredLeaves + p.estimatedLeaves;
  const leafPct = leaves > 0 ? ((p.measuredLeaves / leaves) * 100).toFixed(0) : '0';
  lines.push(
    `valores   : ${p.groundedDecisions} decisoes 100% medidas, ` +
      `${p.speculativeDecisions} com folha estimada`,
  );
  lines.push(
    `folhas    : ${p.measuredLeaves} medidas de ${leaves} (${leafPct}%), ` +
      `${p.estimatedLeaves} estimadas pelo avaliador`,
  );
  lines.push(
    `custo     : ${result.totals.evaluatorCalls} chamadas ao avaliador, ` +
      `${result.totals.inputTokens} tokens de entrada, US$ ${result.totals.usd.toFixed(6)}, ` +
      `${result.totals.wallMs} ms`,
  );
  if (!p.calibrated) {
    lines.push(
      'aviso     : sem curva de calibracao, a confianca reportada e a crua do modelo — ' +
        'rode `pnpm calibrate` antes de afrouxar qualquer portao.',
    );
  }
  if (p.fidelity === 'speculative') {
    lines.push(
      'aviso     : ambiente speculative — as transicoes da arvore sao suposicoes, ' +
        'nao observacoes. So o que passou pelo executor foi realmente observado.',
    );
  }
  lines.push('═'.repeat(74));
  return lines.join('\n');
}
