import { describe, expect, it } from '@jest/globals';

import { firstJsonObject } from './first-json-object';

describe('firstJsonObject', () => {
  it('cuts trailing content after the first object', () => {
    expect(firstJsonObject('{"message":"hi","draft":{"a":1}}\n{"message":"again"}')).toBe(
      '{"message":"hi","draft":{"a":1}}'
    );
  });

  it('ignores braces and escaped quotes inside strings', () => {
    const obj = '{"message":"use {x} and \\"}\\" here"}';
    expect(firstJsonObject(`${obj} trailing`)).toBe(obj);
    expect(JSON.parse(firstJsonObject(`${obj} trailing`)!)).toEqual({ message: 'use {x} and "}" here' });
  });

  it('returns null for an incomplete object', () => {
    expect(firstJsonObject('{"message":"cut')).toBeNull();
  });
});
