/**
 * An `EventSource` a test drives by hand.
 *
 * Shared rather than per-feature, because the bug it exists to catch is not one
 * feature's. It implements `addEventListener` and **not** `onmessage`, on purpose: the
 * API names every frame it sends, so a client wired to `onmessage` receives nothing
 * from the real server - and a double that fired `onmessage` anyway would let that bug
 * pass every test in the suite and fail on the first real page load. That is exactly
 * what happened, and this class is the shape of the fix.
 */

import type { RunEvent } from '../api/schemas/pending-contracts';

export class FakeEventSource {
  static readonly opened: FakeEventSource[] = [];

  readonly url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  /**
   * `0` CONNECTING, `1` OPEN, `2` CLOSED - the real enum.
   *
   * It is the field the reconnect logic branches on, and the branch is the whole
   * difference between "the browser is retrying with `Last-Event-ID`" and "the browser
   * has given up". A double without it could not tell those two apart, which is
   * exactly the bug the branch exists to prevent.
   */
  readyState = 0;
  readonly #listeners = new Map<string, ((event: Event) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.opened.push(this);
  }

  addEventListener(name: string, handler: (event: Event) => void): void {
    const existing = this.#listeners.get(name) ?? [];
    this.#listeners.set(name, [...existing, handler]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Delivers a named frame the way a browser would. */
  emit(event: RunEvent): void {
    this.raw(event.type, JSON.stringify(event));
  }

  raw(name: string, data: string): void {
    for (const handler of this.#listeners.get(name) ?? []) {
      handler({ data } as unknown as Event);
    }
  }

  /** A transient drop: the browser is already retrying, and will send `Last-Event-ID`. */
  drop(): void {
    this.readyState = 0;
    this.onerror?.();
  }

  /** A fatal error - a 404, a dead server. The browser will not retry this socket. */
  fail(): void {
    this.readyState = 2;
    this.onerror?.();
  }

  /** Fired only for frames with no `event:` name. Nothing the API sends lands here. */
  message(data: string): void {
    this.raw('message', data);
  }

  asEventSource(): EventSource {
    return this as unknown as EventSource;
  }
}
