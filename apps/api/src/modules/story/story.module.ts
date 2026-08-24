/**
 * S2 Story over HTTP.
 *
 * ## Report - two schema families that belong in `@rv/contracts` and are not there
 *
 * Non-negotiable #5 puts every shape in `@rv/contracts`, and two of the shapes these
 * routes answer with are declared in `apps/api/src/story/` instead:
 *
 * | shape                                                   | declared in                                    |
 * | ------------------------------------------------------- | ---------------------------------------------- |
 * | `StoryNode`, `StoryTree`, `StoryExpansion`, `StoryNodeEdit` | `apps/api/src/story/story.contracts.ts`     |
 * | `CharacterStateCell`, `CharacterStates`, `CharacterStateEdit` | `apps/api/src/story/cast.contracts.ts`    |
 *
 * They are declared here because the studio declared them **first**, in
 * `apps/web/src/features/story/api/story-tree.ts` and
 * `apps/web/src/features/characters/api/graph.ts`, and both of those files' own headers
 * say the shapes belong upstream "when the routes land". Adding a third definition
 * inside `@rv/contracts` while two already exist would be exactly the drift the rule
 * prevents. The move is one commit - lift the two files into
 * `packages/contracts/src/story/` beside `OutlineEnvelope`, re-export from both apps -
 * and it needs the `@rv/contracts` workstream, not this one. The shapes here are a
 * field-for-field mirror of the studio's, so the move is a deletion on both sides.
 *
 * `OUTLINE_LEVELS` in particular is now spelled out four times: here, in the studio, in
 * `@rv/story-engine`'s outliner, and in docs/02 §1. The engine's copy is the one that
 * *guards* an expansion and should stay; the other three should become imports.
 */

import { Module } from '@nestjs/common';

import { StoryController } from './story.controller';

@Module({ controllers: [StoryController] })
export class StoryModule {}
