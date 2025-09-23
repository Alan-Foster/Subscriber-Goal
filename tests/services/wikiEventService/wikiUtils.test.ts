/**
 * @file Tests for src/services/wikiEventService/wikiUtils.ts.
 */
import {isValidRevisionReason, normalizeWikiPath, normalizeWikiPathWithRevision} from '../../../src/services/wikiEventService/wikiUtils.js';

describe('normalizeWikiPath', () => {
  it('should strip leading and trailing slashes', () => {
    expect(normalizeWikiPath('/example/path/')).toBe('/example/path');
  });
  it('should trim whitespace', () => {
    expect(normalizeWikiPath('  example/path  ')).toBe('/example/path');
  });
  it('should convert to lowercase', () => {
    expect(normalizeWikiPath('ExAmPlE/PaTh')).toBe('/example/path');
  });
  it('should remove leading "wiki/" segments', () => {
    expect(normalizeWikiPath('wiki/example/path')).toBe('/example/path');
  });
  it('should handle multiple consecutive slashes', () => {
    expect(normalizeWikiPath('//example///path')).toBe('/example/path');
  });
  it('should handle paths that are just "wiki"', () => {
    expect(normalizeWikiPath('wiki')).toBe('/wiki');
    expect(normalizeWikiPath('/wiki/')).toBe('/wiki');
    expect(normalizeWikiPath('wiki/wiki')).toBe('/wiki');
  });
  it('should handle a mix of all cases', () => {
    expect(normalizeWikiPath('  /WiKi//ExAmPlE/PaTh///  ')).toBe('/example/path');
  });
  it('should throw an error for empty paths after normalization', () => {
    expect(() => normalizeWikiPath('   ')).toThrow();
    expect(() => normalizeWikiPath('///')).toThrow();
  });
});

describe('isValidRevisionReason', () => {
  it('should return true for valid ASCII strings within length limit', () => {
    expect(isValidRevisionReason('Valid reason!')).toBe(true);
    expect(isValidRevisionReason('A'.repeat(256))).toBe(true);
  });

  it('should return false for strings exceeding length limit', () => {
    expect(isValidRevisionReason('A'.repeat(257))).toBe(false);
    expect(isValidRevisionReason('This reason is way too long '.repeat(256))).toBe(false);
  });

  it('should return false for strings with non-printable ASCII characters or Unicode', () => {
    expect(isValidRevisionReason('Invalid reason\u0001')).toBe(false); // Contains a control character
    expect(isValidRevisionReason('Another invalid reason\u007F')).toBe(false); // Contains DEL character
    expect(isValidRevisionReason('Invalid reason with emoji 😊')).toBe(false); // Contains emoji
  });

  it('should allow for basic JSON data', () => {
    expect(isValidRevisionReason('{"key":"value","number":123}')).toBe(true);
  });
});

describe('normalizeWikiPathWithRevision', () => {
  it('should return true for valid ASCII strings within length limit', () => {
    expect(normalizeWikiPathWithRevision('/path/a/b/c/', 'revisionid')).toEqual('/path/a/b/c?v=revisionid&raw_json=1&');
  });
});
