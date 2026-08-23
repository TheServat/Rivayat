/**
 * The SSE surface and the bus behind it.
 *
 * The bus is a provider rather than a singleton import so that a test can build one
 * over a `FixedClock` and assert event timestamps, and so `onApplicationShutdown`
 * actually closes the open streams instead of leaving the process holding sockets.
 */

import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Clock } from '@rv/shared-kernel';

import { CLOCK, RUN_EVENT_BUS } from '../tokens';
import { RunEventBus } from './run-event-bus';
import { RunEventsController } from './run-events.controller';

@Global()
@Module({
  controllers: [RunEventsController],
  providers: [
    {
      provide: RUN_EVENT_BUS,
      inject: [CLOCK],
      useFactory: (clock: Clock): RunEventBus => new RunEventBus({ clock }),
    },
  ],
  exports: [RUN_EVENT_BUS],
})
export class EventsModule implements OnApplicationShutdown {
  readonly #bus: RunEventBus;

  constructor(@Inject(RUN_EVENT_BUS) bus: RunEventBus) {
    this.#bus = bus;
  }

  onApplicationShutdown(): void {
    this.#bus.closeAll();
  }
}
