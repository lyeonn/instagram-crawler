import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThreadsModule } from './threads/threads.module';
import { InstagramModule } from './instagram/instagram.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }), // .env 로드
    ScheduleModule.forRoot(), // 스케줄러(cron) 활성화
    ThreadsModule,
    InstagramModule,
  ],
})
export class AppModule {}
