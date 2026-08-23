/**
 * Pipeline contracts: what a run is, what a job is, and what either is allowed to do
 * next.
 *
 * Three files, in dependency order: `stage` (the twelve stages, the lifecycle and its
 * transition table, and the artefact reference a checkpoint is built from), `run` (the
 * resumable execution and its per-stage checkpoints), `job` (one unit of work inside
 * it).
 */

export * from './stage';
export * from './run';
export * from './job';
