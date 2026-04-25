import type { InboundEvent } from '../types/events.js';
import type { Run, RunStage } from '../types/runs.js';

export interface HandlerRoute {
  event_type: InboundEvent['type'];
  stage: RunStage | 'new_thread';
  intent: string;
}

export type HandlerFn = (event: InboundEvent, run: Run | undefined) => Promise<void> | void;

export interface HandlerRegistry {
  register(route: HandlerRoute, handler: HandlerFn): void;
  resolve(route: HandlerRoute): HandlerFn | undefined;
}

export class HandlerRegistryImpl implements HandlerRegistry {
  private readonly handlers = new Map<string, HandlerFn>();

  register(route: HandlerRoute, handler: HandlerFn): void {
    const key = routeKey(route);
    if (this.handlers.has(key)) {
      throw new Error(`Handler route already registered: ${key}`);
    }
    this.handlers.set(key, handler);
  }

  resolve(route: HandlerRoute): HandlerFn | undefined {
    return this.handlers.get(routeKey(route));
  }
}

function routeKey(route: HandlerRoute): string {
  return [
    route.event_type,
    route.stage,
    route.intent,
  ].join('|');
}
