import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // public/ 폴더의 대시보드 화면(index.html)을 정적으로 서빙
  app.useStaticAssets(join(__dirname, '..', 'public'));
  const port = process.env.PORT ?? 3100;
  await app.listen(port);
  Logger.log(`VEASLY 구동: http://localhost:${port}`, 'Bootstrap');
  Logger.log(`대시보드: http://localhost:${port}/`, 'Bootstrap');
}
bootstrap();
