import { Module } from '@nestjs/common';
import { InstagramService } from './instagram.service';
import { InstagramController } from './instagram.controller';
import { InstagramScheduler } from './instagram.scheduler';
import { SheetsModule } from '../sheets/sheets.module';

@Module({
  imports: [SheetsModule],
  controllers: [InstagramController],
  providers: [InstagramService, InstagramScheduler],
  exports: [InstagramService],
})
export class InstagramModule {}
