import { Module } from '@nestjs/common';

import { StyleController } from './style.controller';

@Module({ controllers: [StyleController] })
export class StyleModule {}
