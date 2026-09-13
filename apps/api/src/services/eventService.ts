import type { EventCategory, EventLevel } from '@netpulse/shared';

import type { EventsRepository } from '../db/repositories';

export interface EventListQuery {
  level?: EventLevel;
  category?: EventCategory;
  limit?: number;
  beforeTs?: number;
}

export class EventService {
  constructor(private readonly repo: EventsRepository) {}

  record(level: EventLevel, category: EventCategory, message: string, data?: Record<string, unknown>): void {
    this.repo.insert(level, category, message, data);
  }

  list(query: EventListQuery) {
    return this.repo.list(query);
  }
}
