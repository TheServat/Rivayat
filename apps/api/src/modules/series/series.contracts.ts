/**
 * Request shapes for the series surface.
 *
 * The interesting one is what is *not* here: there is no "create a series bible"
 * request. `SeriesBible` is produced by S2 from a brief and a locked style, not posted
 * by a client, and offering an endpoint that accepts one would invite a client to
 * bypass the stage that keeps it consistent with the narrative graph.
 */

import { ProjectId, SeriesId } from '@rv/contracts';
import type { z } from 'zod';

import { SeriesCard } from '../../application/resources';

export const CreateSeriesRequest = SeriesCard.pick({ title: true, premise: true });
export type CreateSeriesRequest = z.infer<typeof CreateSeriesRequest>;

export const SeriesIdParam = SeriesId;
export const ProjectIdParam = ProjectId;
