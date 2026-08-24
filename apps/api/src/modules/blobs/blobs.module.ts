import { Module } from '@nestjs/common';

import { BlobsController } from './blobs.controller';

@Module({ controllers: [BlobsController] })
export class BlobsModule {}
