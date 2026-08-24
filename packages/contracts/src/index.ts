/**
 * `@rv/contracts` - the single source of truth for every shape in the system.
 *
 * Types are `z.infer`red from these schemas, never hand-written beside them. The same
 * schemas produce the JSON Schema an LLM is constrained by (`toLlmJsonSchema`) and the
 * DTOs the API exposes, so those three can never drift apart.
 *
 * Barrel order follows the dependency order of the domain: primitives, then the
 * project everything hangs off, then style, then the narrative world model, then story
 * structure, then assets and animation, then the operational concerns.
 */

export * from './primitives/ids';
export * from './primitives/common';

export * from './project/project';
export * from './project/series-card';

export * from './style/style-bible';

export * from './narrative/index';
export * from './story/index';

export * from './asset/asset-spec';
export * from './asset/rig';
export * from './asset/representation';
export * from './asset/asset';
export * from './asset/clip-library';

export * from './anim/easing';
export * from './anim/ir';
export * from './anim/channels';
export * from './anim/features';
export * from './anim/motion';

export * from './audio/index';

export * from './provider/index';
export * from './pipeline/index';
export * from './render/index';

export * from './settings/index';

export * from './json-schema';
