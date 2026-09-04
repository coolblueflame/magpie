import { describe, expect, test } from 'vitest';
import { csvObjects, parseCsv } from './csv';

describe('parseCsv', () => {
  test('plain rows with a trailing newline', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
  test('quoted fields, doubled quotes, CRLF', () => {
    expect(parseCsv('"x, y","he said ""hi"""\r\n')).toEqual([['x, y', 'he said "hi"']]);
  });
  test('embedded newline inside quotes', () => {
    expect(parseCsv('"multi\nline",z')).toEqual([['multi\nline', 'z']]);
  });
  test('strips a UTF-8 BOM', () => {
    expect(parseCsv('﻿a,b\n')).toEqual([['a', 'b']]);
  });
  test('empty text and empty fields', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('a,,c\n')).toEqual([['a', '', 'c']]);
  });
});

describe('csvObjects', () => {
  test('keys from the header; short rows padded', () => {
    expect(csvObjects('a,b\n1\n')).toEqual([{ a: '1', b: '' }]);
  });
});
