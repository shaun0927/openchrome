import { _domainForDynamicSkillLookupForTesting } from '../../../src/tools/navigate';

describe('navigate dynamic-skill domain lookup normalization', () => {
  test('normalizes common first-party subdomains to the recorded apex domain', () => {
    expect(_domainForDynamicSkillLookupForTesting('www.example.com')).toBe('example.com');
    expect(_domainForDynamicSkillLookupForTesting('app.checkout.example.com')).toBe('example.com');
  });

  test('keeps common multi-label public suffix registrable domains intact', () => {
    expect(_domainForDynamicSkillLookupForTesting('www.example.co.uk')).toBe('example.co.uk');
  });

  test('leaves localhost and IPv4 hosts unchanged', () => {
    expect(_domainForDynamicSkillLookupForTesting('localhost')).toBe('localhost');
    expect(_domainForDynamicSkillLookupForTesting('127.0.0.1')).toBe('127.0.0.1');
  });
});
