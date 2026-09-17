import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args.js';

describe('parseArgs', () => {
  it('argv vazio produz flags, opcoes e posicionais vazios', () => {
    const args = parseArgs([]);
    expect(args.flags.size).toBe(0);
    expect(args.options.size).toBe(0);
    expect(args.positional).toEqual([]);
  });

  it('flag solta vira flag e nao opcao', () => {
    const args = parseArgs(['--verbose']);
    expect(args.flags.has('verbose')).toBe(true);
    expect(args.options.has('verbose')).toBe(false);
    expect(args.positional).toEqual([]);
  });

  it('flag seguida de outra flag continua solta', () => {
    const args = parseArgs(['--a', '--b']);
    expect(args.flags.has('a')).toBe(true);
    expect(args.flags.has('b')).toBe(true);
    expect(args.options.size).toBe(0);
  });

  it('chave seguida de valor vira opcao e consome o valor', () => {
    const args = parseArgs(['--spec', 'examples/x.json']);
    expect(args.options.get('spec')).toBe('examples/x.json');
    expect(args.flags.has('spec')).toBe(false);
    expect(args.positional).toEqual([]);
  });

  it('chave=valor vira opcao sem consumir o proximo token', () => {
    const args = parseArgs(['--spec=examples/x.json', 'resto']);
    expect(args.options.get('spec')).toBe('examples/x.json');
    expect(args.positional).toEqual(['resto']);
  });

  it('chave=valor preserva sinais de igual no valor', () => {
    const args = parseArgs(['--q=a=b']);
    expect(args.options.get('q')).toBe('a=b');
  });

  it('chave= sem valor vira opcao com string vazia', () => {
    const args = parseArgs(['--q=']);
    expect(args.options.get('q')).toBe('');
    expect(args.has('q')).toBe(true);
  });

  it('tokens sem -- sao posicionais na ordem em que aparecem', () => {
    const args = parseArgs(['replay', 'runs/a.ndjson', '--seed', '7', 'depois']);
    expect(args.positional).toEqual(['replay', 'runs/a.ndjson', 'depois']);
    expect(args.options.get('seed')).toBe('7');
  });

  it('a ultima ocorrencia de uma chave repetida vence', () => {
    const args = parseArgs(['--seed', '1', '--seed=2']);
    expect(args.options.get('seed')).toBe('2');
  });

  it('str devolve o valor da opcao ou o fallback quando ausente', () => {
    const args = parseArgs(['--model', 'jev-1']);
    expect(args.str('model', 'padrao')).toBe('jev-1');
    expect(args.str('outro', 'padrao')).toBe('padrao');
  });

  it('str nao usa o fallback para flag solta', () => {
    const args = parseArgs(['--dry-run']);
    expect(args.str('dry-run', 'padrao')).toBe('padrao');
    expect(args.has('dry-run')).toBe(true);
  });

  it('num converte o valor e devolve o fallback quando ausente', () => {
    const args = parseArgs(['--depth', '3', '--rate=0.5', '--neg', '-2']);
    expect(args.num('depth', 9)).toBe(3);
    expect(args.num('rate', 9)).toBe(0.5);
    expect(args.num('neg', 9)).toBe(-2);
    expect(args.num('ausente', 9)).toBe(9);
  });

  it('num devolve o fallback para valor nao numerico ou nao finito', () => {
    const args = parseArgs(['--depth', 'muito', '--inf=Infinity', '--vazio=']);
    expect(args.num('depth', 4)).toBe(4);
    expect(args.num('inf', 4)).toBe(4);
    expect(args.num('vazio', 4)).toBe(0);
  });

  it('has enxerga flags e opcoes, mas nao posicionais', () => {
    const args = parseArgs(['--flag', '--chave', 'valor', 'posicional']);
    expect(args.has('flag')).toBe(true);
    expect(args.has('chave')).toBe(true);
    expect(args.has('posicional')).toBe(false);
    expect(args.has('inexistente')).toBe(false);
  });
});
