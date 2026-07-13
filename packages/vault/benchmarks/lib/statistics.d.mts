export interface PercentileStats {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  p999: number;
  stddev: number;
  samples: number;
}

export interface DistributionSummary {
  samples: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  iqr: number;
  max: number;
}

export interface HistogramBucket {
  lowerBound: number;
  upperBound: number;
  count: number;
}

export const PERCENTILE_MIN_SAMPLES: Readonly<{
  p90: number;
  p95: number;
  p99: number;
  p999: number;
}>;

export function calculatePercentiles(samples: readonly number[]): PercentileStats;
export function percentileEligibility(samples: number): {
  p90: boolean;
  p95: boolean;
  p99: boolean;
  p999: boolean;
};
export function summarizeDistribution(samples: readonly number[]): DistributionSummary;
export function deterministicShuffle<T>(values: readonly T[], seed: number): T[];
export function logarithmicHistogram(samples: readonly number[]): HistogramBucket[];
