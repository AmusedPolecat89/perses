// Copyright OBSESC Authors
//
// EC2 instance specs for the NodeManager's resize dialog. Hourly
// prices are us-east-1 on-demand snapshots; treat them as estimates,
// not invoices. The dialog labels them "approx" accordingly.
// Cleanest production move is to fetch live pricing from the AWS
// Pricing API at boot; β.3.5 territory.

export interface InstanceSpec {
  id: string;
  vcpu: number;
  memoryGb: number;
  approxHourlyUsd: number;
  recommendedFor: string;
}

// B4.4: the list must cover every family the CloudFormation template's
// InstanceType AllowedValues admits (c6in.* — the family all perf validation
// ran on), and must mirror the server table in
// crates/platform/obsesc-provision/src/pricing.rs exactly.
export const INSTANCE_TYPES: InstanceSpec[] = [
  { id: 'c7i.large', vcpu: 2, memoryGb: 4, approxHourlyUsd: 0.0892, recommendedFor: 'Light load — <20k ev/s' },
  { id: 'c7i.xlarge', vcpu: 4, memoryGb: 8, approxHourlyUsd: 0.1785, recommendedFor: 'Light load — <60k ev/s' },
  { id: 'c7i.2xlarge', vcpu: 8, memoryGb: 16, approxHourlyUsd: 0.357, recommendedFor: 'Default — <150k ev/s' },
  { id: 'c7i.4xlarge', vcpu: 16, memoryGb: 32, approxHourlyUsd: 0.714, recommendedFor: 'Heavy load — <300k ev/s' },
  { id: 'c7i.8xlarge', vcpu: 32, memoryGb: 64, approxHourlyUsd: 1.428, recommendedFor: 'Peak load — <600k ev/s' },
  { id: 'c6in.large', vcpu: 2, memoryGb: 4, approxHourlyUsd: 0.2268, recommendedFor: 'Network-optimized — light load' },
  { id: 'c6in.xlarge', vcpu: 4, memoryGb: 8, approxHourlyUsd: 0.4536, recommendedFor: 'Network-optimized — light load' },
  { id: 'c6in.2xlarge', vcpu: 8, memoryGb: 16, approxHourlyUsd: 0.9072, recommendedFor: 'CFN default — perf-validated ingest node' },
  { id: 'c6in.4xlarge', vcpu: 16, memoryGb: 32, approxHourlyUsd: 1.8144, recommendedFor: 'Heavy ingest — perf-validated' },
  { id: 'c6in.8xlarge', vcpu: 32, memoryGb: 64, approxHourlyUsd: 3.6288, recommendedFor: 'Peak ingest' },
  { id: 'c6in.12xlarge', vcpu: 48, memoryGb: 96, approxHourlyUsd: 5.4432, recommendedFor: 'Peak ingest' },
  { id: 'c6in.16xlarge', vcpu: 64, memoryGb: 128, approxHourlyUsd: 7.2576, recommendedFor: 'Peak ingest' },
  { id: 'c6in.24xlarge', vcpu: 96, memoryGb: 192, approxHourlyUsd: 10.8864, recommendedFor: 'Peak ingest' },
];

// 730 hours ~ a calendar month (AWS billing convention).
export const HOURS_PER_MONTH = 730;

export function monthlyUsd(spec: InstanceSpec): number {
  return spec.approxHourlyUsd * HOURS_PER_MONTH;
}

export function findInstance(id: string): InstanceSpec | undefined {
  return INSTANCE_TYPES.find((i) => i.id === id);
}
