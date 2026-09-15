import { describe, expect, it } from 'vitest';
import { setup, sync } from '../src/main';

describe('main', () => {
  it('exports sync as a function', () => {
    expect(typeof sync).toBe('function');
  });

  it('exports setup as a function', () => {
    expect(typeof setup).toBe('function');
  });
});
