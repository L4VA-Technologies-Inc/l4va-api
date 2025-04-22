import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import * as bodyParser from 'body-parser';
import { json } from 'express';

import { AppModule } from './app.module';


async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Configure raw body parser for webhook endpoint
  app.use('/blockchain/tx-webhook', bodyParser.raw({ type: 'application/json' }));
  // Use regular JSON parser for all other routes
  app.use(json());

  app.setGlobalPrefix('api');
  app.use(bodyParser.json({ limit: '50mb' }));
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  const config = new DocumentBuilder()
    .setTitle('L4VA API Documentation')
    .setDescription('API documentation for the L4VA system')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: false,
    transform: true,
    transformOptions: { excludeExtraneousValues: true }
  }));

  await app.listen(process.env.PORT ?? 3000).then((() => {
    console.log(`Server started on port: ${process.env.PORT ?? 3000}`);
  }));
}
bootstrap();
