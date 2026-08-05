export interface CalendarCollectionIdentity {
  readonly providerId: string;
  readonly href: string;
}

export interface CalendarCollectionSummary extends CalendarCollectionIdentity {
  readonly displayName: string;
  readonly color: string | null;
  readonly supportsEvents: boolean;
  readonly supportsTodos: boolean;
}

export interface CalendarDiscoveryPort {
  discoverCollections(): Promise<readonly CalendarCollectionSummary[]>;
}
