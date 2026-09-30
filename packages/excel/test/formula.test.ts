import { describe, expect, it } from 'vitest';
import { cellAddress, columnName, formatGeneral, parseCellRef, parseRange, shiftFormula } from '../src/index.js';

describe('共有数式の参照ずらし（決定 33）', () => {
  it('相対参照だけをずらし、$ の付いた側は動かさない', () => {
    expect(shiftFormula('A2*2', 1, 0)).toBe('A3*2');
    expect(shiftFormula('A2+$B$1+$C3+D$4', 2, 1)).toBe('B4+$B$1+$C5+E$4');
  });

  it('範囲・列全体・行全体', () => {
    expect(shiftFormula('SUM(A1:B2)', 1, 1)).toBe('SUM(B2:C3)');
    expect(shiftFormula('SUM(A:A)', 5, 2)).toBe('SUM(C:C)');
    expect(shiftFormula('SUM($A:B)', 0, 1)).toBe('SUM($A:C)');
    expect(shiftFormula('SUM(1:3)', 2, 9)).toBe('SUM(3:5)');
  });

  it('シート修飾（引用符付きを含む）の後ろの参照もずらす', () => {
    expect(shiftFormula('Sheet1!A1+Data2!B2', 1, 0)).toBe('Sheet1!A2+Data2!B3');
    expect(shiftFormula("'My ''Sheet'''!A1", 0, 1)).toBe("'My ''Sheet'''!B1");
  });

  it('文字列リテラル・関数名・構造化参照・数値は触らない', () => {
    expect(shiftFormula('"A1"&A1', 1, 0)).toBe('"A1"&A2');
    expect(shiftFormula('LOG10(A1)+ATAN2(B1,C1)', 1, 0)).toBe('LOG10(A2)+ATAN2(B2,C2)');
    expect(shiftFormula('Table1[[#This Row],[A1]]+1.5E+10', 1, 0)).toBe('Table1[[#This Row],[A1]]+1.5E+10');
    expect(shiftFormula('TRUE+A1', 1, 0)).toBe('TRUE+A2');
  });

  it('シートの外へ出た参照は #REF!', () => {
    expect(shiftFormula('A1', -1, 0)).toBe('#REF!');
    expect(shiftFormula('A1+B2', 0, -1)).toBe('#REF!+A2');
  });

  it('ずらしが 0 なら元のまま', () => {
    expect(shiftFormula('A1', 0, 0)).toBe('A1');
  });
});

describe('セル番地', () => {
  it('列文字との往復', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(16383)).toBe('XFD');
    expect(cellAddress(11, 1)).toBe('B12');
  });

  it('番地と範囲を読む。範囲外・壊れた形は null', () => {
    expect(parseCellRef('B12')).toEqual({ row: 11, col: 1 });
    expect(parseCellRef('$B$12')).toEqual({ row: 11, col: 1 });
    expect(parseCellRef('XFE1')).toBeNull();
    expect(parseCellRef('A0')).toBeNull();
    expect(parseCellRef('A1x')).toBeNull();
    expect(parseRange('C3:A1')).toEqual({ r1: 0, c1: 0, r2: 2, c2: 2 });
    expect(parseRange('B2')).toEqual({ r1: 1, c1: 1, r2: 1, c2: 1 });
    expect(parseRange('A:B')).toBeNull();
  });
});

describe('標準書式の数値', () => {
  it.each([
    [0, '0'],
    [42, '42'],
    [-3.5, '-3.5'],
    [0.1 + 0.2, '0.3'],
    [1234.56789012, '1234.56789'],
    [123456789012, '1.23457E+11'],
    [0.000012345678, '1.23457E-05'],
    [0.0001234, '0.0001234'],
    [-1234567.12345, '-1234567.12'],
    [1e-10, '1E-10'],
  ])('%s → %s', (value, expected) => {
    expect(formatGeneral(value)).toBe(expected);
  });
});
