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

export const INSTANCE_TYPES: InstanceSpec[] = [
  { id: 'c7i.large', vcpu: 2, memoryGb: 4, approxHourlyUsd: 0.0892, recommendedFor: 'Light load — <20k ev/s' },
  { id: 'c7i.xlarge', vcpu: 4, memoryGb: 8, approxHourlyUsd: 0.1785, recommendedFor: 'Light load — <60k ev/s' },
  { id: 'c7i.2xlarge', vcpu: 8, memoryGb: 16, approxHourlyUsd: 0.357, recommendedFor: 'Default — <150k ev/s' },
  { id: 'c7i.4xlarge', vcpu: 16, memoryGb: 32, approxHourlyUsd: 0.714, recommendedFor: 'Heavy load — <300k ev/s' },
  { id: 'c7i.8xlarge', vcpu: 32, memoryGb: 64, approxHourlyUsd: 1.428, recommendedFor: 'Peak load — <600k ev/s' },
];

// 730 hours ~ a calendar month (AWS billing convention).
export const HOURS_PER_MONTH = 730;

export function monthlyUsd(spec: InstanceSpec): number {
  return spec.approxHourlyUsd * HOURS_PER_MONTH;
}

export function findInstance(id: string): InstanceSpec | undefined {
  return INSTANCE_TYPES.find((i) => i.id === id);
}
