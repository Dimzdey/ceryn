import {
  calculatePercentiles,
  deterministicShuffle,
  logarithmicHistogram,
  percentileEligibility,
  summarizeDistribution,
} from '../benchmarks/lib/statistics.mjs';

describe('benchmark statistics', () => {
  it('calculates nearest-rank percentiles without mutating samples', () => {
    const samples = [5, 1, 4, 2, 3];

    expect(calculatePercentiles(samples)).toMatchObject({
      samples: 5,
      min: 1,
      p50: 3,
      p90: 5,
      max: 5,
      mean: 3,
    });
    expect(samples).toEqual([5, 1, 4, 2, 3]);
  });

  it.each([
    [99, false, false, false, false],
    [100, true, false, false, false],
    [200, true, true, false, false],
    [1_000, true, true, true, false],
    [10_000, true, true, true, true],
  ])('gates tail percentiles for %i samples', (samples, p90, p95, p99, p999) => {
    expect(percentileEligibility(samples)).toEqual({ p90, p95, p99, p999 });
  });

  it('summarizes independent runs with median and interquartile range', () => {
    expect(summarizeDistribution([8, 1, 6, 3, 7, 2, 5, 4])).toEqual({
      samples: 8,
      min: 1,
      q1: 2,
      median: 4,
      q3: 6,
      iqr: 4,
      max: 8,
    });
  });

  it('shuffles deterministically without changing the input', () => {
    const values = ['Ceryn', 'Tsyringe', 'Inversify', 'TypeDI', 'Needle'];

    const first = deterministicShuffle(values, 42);
    const second = deterministicShuffle(values, 42);

    expect(first).toEqual(second);
    expect(first).not.toEqual(values);
    expect([...first].sort()).toEqual([...values].sort());
    expect(values).toEqual(['Ceryn', 'Tsyringe', 'Inversify', 'TypeDI', 'Needle']);
  });

  it('accounts for every positive sample in logarithmic buckets', () => {
    const histogram = logarithmicHistogram([1, 2, 3, 4, 8, 9]);

    expect(histogram).toEqual([
      { lowerBound: 1, upperBound: 1, count: 1 },
      { lowerBound: 2, upperBound: 3, count: 2 },
      { lowerBound: 4, upperBound: 7, count: 1 },
      { lowerBound: 8, upperBound: 15, count: 2 },
    ]);
    expect(histogram.reduce((total, bucket) => total + bucket.count, 0)).toBe(6);
  });
});
