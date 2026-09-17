import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * A probabilidade que o Jev devolve NAO e acuracia. O numero publicado de 67,8%
 * e concordancia com uma referencia derivada de modelo, nao acerto verificado.
 * Portanto nenhum portao deste repositorio usa a probabilidade crua: ela passa
 * por uma curva de confiabilidade ajustada contra rotulos observados.
 *
 * Enquanto nao houver curva ajustada, `identityCalibration()` mantem o numero
 * como esta e marca a decisao como `uncalibrated` -- e os portoes apertam.
 */
export interface CalibrationBin {
  readonly lo: number;
  readonly hi: number;
  /** Fracao observada de verdadeiros nos exemplos que cairam nesta faixa. */
  readonly observed: number;
  readonly n: number;
}

export interface Calibration {
  readonly model: string;
  readonly fittedAt: string;
  readonly n: number;
  readonly bins: readonly CalibrationBin[];
  /** Brier score: media de (p - rotulo)^2. Menor e melhor; 0.25 = moeda. */
  readonly brier: number;
  /** Expected Calibration Error: distancia media entre confianca e acerto. */
  readonly ece: number;
  /** Acuracia bruta com corte em 0.5, so para leitura. */
  readonly accuracy: number;
  readonly fitted: boolean;
}

export interface LabeledSample {
  readonly p: number;
  readonly label: boolean;
}

export function identityCalibration(model = 'unknown'): Calibration {
  return {
    model,
    fittedAt: new Date(0).toISOString(),
    n: 0,
    bins: [],
    brier: Number.NaN,
    ece: Number.NaN,
    accuracy: Number.NaN,
    fitted: false,
  };
}

export function fitCalibration(
  samples: readonly LabeledSample[],
  model: string,
  binCount = 10,
): Calibration {
  if (samples.length === 0) return identityCalibration(model);
  const buckets: { sum: number; hits: number; n: number }[] = Array.from(
    { length: binCount },
    () => ({ sum: 0, hits: 0, n: 0 }),
  );
  let brier = 0;
  let correct = 0;
  for (const sample of samples) {
    const p = Math.min(1, Math.max(0, sample.p));
    const index = Math.min(binCount - 1, Math.floor(p * binCount));
    const bucket = buckets[index] as { sum: number; hits: number; n: number };
    bucket.sum += p;
    bucket.hits += sample.label ? 1 : 0;
    bucket.n += 1;
    brier += (p - (sample.label ? 1 : 0)) ** 2;
    if ((p >= 0.5) === sample.label) correct += 1;
  }
  const bins: CalibrationBin[] = [];
  let ece = 0;
  buckets.forEach((bucket, i) => {
    if (bucket.n === 0) return;
    const observed = bucket.hits / bucket.n;
    const mean = bucket.sum / bucket.n;
    bins.push({ lo: i / binCount, hi: (i + 1) / binCount, observed, n: bucket.n });
    ece += (bucket.n / samples.length) * Math.abs(mean - observed);
  });
  return {
    model,
    fittedAt: new Date().toISOString(),
    n: samples.length,
    bins,
    brier: brier / samples.length,
    ece,
    accuracy: correct / samples.length,
    fitted: bins.length > 0,
  };
}

/** Mapeia probabilidade crua -> confianca calibrada por interpolacao linear. */
export function calibrate(calibration: Calibration, p: number): number {
  const x = Math.min(1, Math.max(0, p));
  if (!calibration.fitted || calibration.bins.length === 0) return x;
  const points = calibration.bins.map((bin) => ({
    at: (bin.lo + bin.hi) / 2,
    value: bin.observed,
  }));
  const first = points[0] as { at: number; value: number };
  const last = points[points.length - 1] as { at: number; value: number };
  if (x <= first.at) return first.value;
  if (x >= last.at) return last.value;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as { at: number; value: number };
    const b = points[i] as { at: number; value: number };
    if (x <= b.at) {
      const span = b.at - a.at;
      const ratio = span === 0 ? 0 : (x - a.at) / span;
      return a.value + ratio * (b.value - a.value);
    }
  }
  return last.value;
}

/** Spearman: o Jev ORDENA estados como a verdade ordena? Usado em tools/calibrate. */
export function spearman(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length < 2) return Number.NaN;
  const rank = (values: readonly number[]): number[] => {
    const order = values.map((v, i) => ({ v, i })).sort((x, y) => x.v - y.v);
    const ranks = new Array<number>(values.length).fill(0);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && (order[j + 1] as { v: number }).v === (order[i] as { v: number }).v) j++;
      const mean = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[(order[k] as { i: number }).i] = mean;
      i = j + 1;
    }
    return ranks;
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  const mean = (n + 1) / 2;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = (ra[i] as number) - mean;
    const y = (rb[i] as number) - mean;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? Number.NaN : num / den;
}

export function saveCalibration(path: string, calibration: Calibration): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(calibration, null, 2), 'utf8');
}

/**
 * Uma curva vale para o modelo e a familia de perguntas em que foi ajustada, e
 * para mais nada. Carregar uma curva de outro avaliador seria pior que nao ter
 * curva nenhuma: daria aos portoes uma confianca falsa com aparencia de aferida.
 * Por isso o `model` e conferido e a divergencia devolve a identidade.
 */
export function loadCalibration(path: string, model = 'unknown'): Calibration {
  if (!existsSync(path)) return identityCalibration(model);
  const loaded = JSON.parse(readFileSync(path, 'utf8')) as Calibration;
  if (loaded.model !== model) return identityCalibration(model);
  return loaded;
}
