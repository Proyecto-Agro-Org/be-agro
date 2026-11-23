import type { TechnicalDeviceKey } from '../telemetry/association.contracts.js';

export type MeasurementProvenance = 'physical' | 'derived' | 'estimated' | 'simulated' | 'manual' | 'laboratory';
export type MissingReason = 'absent' | 'invalid' | 'unknown-unit' | 'not-calibrated' | 'insufficient-dependency';

export interface TrustedMeasurementEvent {
  readonly eventId: string;
  readonly sourceId: string;
  readonly device: TechnicalDeviceKey;
  readonly receivedAt: number;
  readonly declaredAt: number | null;
  readonly persistedAt: number;
  readonly magnitude: string;
  readonly unit: string;
  readonly value: number | null;
  readonly missingReason: MissingReason | null;
  readonly provenance: MeasurementProvenance;
  readonly simulated: boolean;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ResolvedPhysicalDevice {
  readonly id: string;
  readonly sourceId: string;
  readonly device: TechnicalDeviceKey;
  readonly lifecycle: 'active' | 'inactive' | 'decommissioned';
  readonly verification: 'verified' | 'unverified';
}

export interface AttributionWindow {
  readonly id: string;
  readonly revision: number;
  readonly realm: string;
  readonly clientId: string;
  readonly fieldId: string;
  readonly areaId: string;
  readonly sensorId: string;
  readonly physicalDeviceId: string;
  readonly validFrom: number;
  readonly validTo: number | null;
}

export type TemporalDecision =
  | { readonly status: 'trusted'; readonly at: number; readonly clock: 'received-at' | 'declared-at-approved' }
  | { readonly status: 'untrusted'; readonly reason: 'untrusted-clock' | 'outside-tolerance' };

export interface MeasurementAttributionPorts {
  readonly devices: { findExact(input: { readonly sourceId: string; readonly device: TechnicalDeviceKey; readonly limit: 2 }): Promise<ResolvedPhysicalDevice[]> };
  readonly associations: { findAt(input: { readonly realm: string; readonly physicalDeviceId: string; readonly at: number; readonly limit: 2 }): Promise<AttributionWindow[]> };
  readonly temporal: { select(event: TrustedMeasurementEvent): Promise<TemporalDecision> };
  readonly catalogue: { accepts(input: { readonly magnitude: string; readonly unit: string; readonly provenance: MeasurementProvenance }): Promise<boolean> };
}

export type AttributionFailure = 'unknown-device' | 'ambiguous-device' | 'unverified-device' | 'inactive-device' |
  'untrusted-clock' | 'no-window' | 'overlap' | 'invalid-catalogue';

export type AttributionResult =
  | { readonly status: 'quarantined'; readonly eventId: string; readonly reason: AttributionFailure }
  | { readonly status: 'verified'; readonly event: TrustedMeasurementEvent; readonly attributedAt: number;
      readonly clock: 'received-at' | 'declared-at-approved'; readonly physicalDeviceId: string;
      readonly realm: string; readonly clientId: string; readonly fieldId: string; readonly areaId: string;
      readonly sensorId: string; readonly associationId: string; readonly associationRevision: number };

export interface AttributedMeasurement {
  readonly id: string;
  readonly eventId: string;
  readonly realm: string;
  readonly clientId: string;
  readonly fieldId: string;
  readonly areaId: string;
  readonly sensorId: string;
  readonly physicalDeviceId: string;
  readonly associationId: string;
  readonly associationRevision: number;
  readonly magnitude: string;
  readonly unit: string;
  readonly value: number | null;
  readonly missingReason: MissingReason | null;
  readonly provenance: MeasurementProvenance;
  readonly receivedAt: number;
  readonly declaredAt: number | null;
  readonly persistedAt: number;
  readonly attributedAt: number;
}

export type MeasurementSelector =
  | { readonly kind: 'sensor'; readonly sensorId: string }
  | { readonly kind: 'device'; readonly physicalDeviceId: string }
  | { readonly kind: 'area'; readonly fieldId: string; readonly areaId: string }
  | { readonly kind: 'field'; readonly fieldId: string };

export interface MeasurementPageRequest {
  readonly selector: MeasurementSelector;
  readonly from: number;
  readonly to: number;
  readonly limit: number;
  readonly after?: { readonly attributedAt: number; readonly id: string };
}

export interface MeasurementPage {
  readonly items: readonly AttributedMeasurement[];
  readonly next: { readonly attributedAt: number; readonly id: string } | null;
}

export interface MeasurementHistoryPort {
  findPage(input: MeasurementPageRequest & { readonly realm: string; readonly clientId: string }): Promise<MeasurementPage>;
}
