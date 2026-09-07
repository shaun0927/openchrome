import { HeapSampler } from './heap-sampler';
import { readProcessMemorySync } from '../../../src/core/process/memory';
jest.mock('../../../src/core/process/memory', () => ({ readProcessMemorySync: jest.fn() }));
const read = readProcessMemorySync as jest.Mock;
const sample = (bytes: number, identity = '10:first') => ({ residentBytes: bytes, identity });

describe('memory stability evidence', () => {
  beforeEach(() => read.mockReset());
  test('initial failure cannot invent zero baseline', () => {
    read.mockImplementation(() => { throw new Error('no process'); });
    expect(() => new HeapSampler({ pid: 10 }).takeBaseline()).toThrow('inconclusive');
  });
  test('failure invalidates window even when caller catches it', () => {
    const sampler = new HeapSampler({ pid: 10 }); read.mockReturnValue(sample(1000)); sampler.takeBaseline();
    read.mockImplementationOnce(() => { throw new Error('denied'); });
    expect(() => sampler.takeSample()).toThrow('inconclusive');
    expect(() => sampler.assertStable(50)).toThrow('inconclusive');
  });
  test('PID reuse is inconclusive rather than memory savings', () => {
    const sampler = new HeapSampler({ pid: 10 });
    read.mockReturnValueOnce(sample(5000)).mockReturnValueOnce(sample(1000, '10:replacement')); sampler.takeBaseline();
    expect(() => sampler.takeSample()).toThrow('identity changed');
  });
  test('intermediate growth cannot hide behind small final sample', () => {
    const sampler = new HeapSampler({ pid: 10 });
    read.mockReturnValueOnce(sample(1000)).mockReturnValueOnce(sample(100 * 1024 * 1024)).mockReturnValueOnce(sample(1000));
    sampler.takeBaseline(); sampler.takeSample(); expect(() => sampler.assertStable(50)).toThrow('Memory unstable');
  });
  test('valid baseline and follow-up can pass', () => {
    read.mockReturnValue(sample(1000)); const sampler = new HeapSampler({ pid: 10 }); sampler.takeBaseline();
    expect(() => sampler.assertStable(1)).not.toThrow();
  });
});
