/**
 * The settings declaration: what can be changed, by whom, and how it is rendered.
 *
 * Architecture 7b in one module. `descriptor.ts` says what a setting *is*, `values.ts`
 * holds the few value types that exist only because a setting needs them,
 * `registry.ts` is the actual list, and `wire.ts` is the envelope those three travel in
 * between the settings route and the settings screen. The resolver that reads them
 * lives in `@rv/settings`, one layer up, because layering a value is a computation and
 * this package holds shapes.
 */

export * from './values';
export * from './descriptor';
export * from './registry';
export * from './wire';
