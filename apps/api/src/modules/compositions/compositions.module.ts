import { Module } from '@nestjs/common';

import { CompositionsController } from './compositions.controller';

@Module({ controllers: [CompositionsController] })
export class CompositionsModule {}
