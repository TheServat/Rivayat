import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

/** No providers of its own: everything it reports is bound globally in `app.module`. */
@Module({ controllers: [HealthController] })
export class HealthModule {}
