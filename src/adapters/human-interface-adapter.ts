import type { InboundEvent } from '../types/events.js';

export interface HumanInterfaceAdapter {
  receive(): AsyncIterable<InboundEvent>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
