import { Module } from '@nestjs/common';

import { SeriesController } from './series.controller';

@Module({ controllers: [SeriesController] })
export class SeriesModule {}
