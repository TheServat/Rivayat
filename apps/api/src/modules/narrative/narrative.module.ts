/**
 * S4 World and the Characters screen's read surface.
 *
 * The state-grid shapes this module answers with - `CharacterStateCell`,
 * `CharacterStates`, `CharacterStateEdit` - are declared in
 * `apps/api/src/story/cast.contracts.ts` rather than in `@rv/contracts`. See
 * `modules/story/story.module.ts` for the whole of that report; the short version is
 * that the studio declared them first and the move upstream is one commit that needs
 * the `@rv/contracts` workstream.
 *
 * `NarrativeSnapshot`, `StoryMark` and `GraphRevision` are in the same position and are
 * declared in `apps/api/src/narrative/snapshot.contracts.ts`. `Entity`, `Relation` and
 * `EpistemicView` - the three shapes that carry the actual data - come from
 * `@rv/contracts` verbatim and are not restated anywhere.
 */

import { Module } from '@nestjs/common';

import { NarrativeController } from './narrative.controller';

@Module({ controllers: [NarrativeController] })
export class NarrativeModule {}
