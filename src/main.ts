import './instrument';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import * as bodyParser from 'body-parser';

import { AppModule } from './app.module';
import { loadSecrets } from './load-gcp-secrets';

async function bootstrap() {
  try {
    await loadSecrets();
    // eslint-disable-next-line no-console
    console.log('Secrets loaded successfully, initializing application modules...');
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to load secrets:', error.message || error);
  }
  const app = await NestFactory.create(AppModule, {
    bodyParser: false, // Disable default body parser so we can configure it manually
  });

  // Configure body parsers with increased limits for webhook endpoint
  // Raw body parser for signature verification on webhook
  app.use('/blockchain/tx-webhook', bodyParser.raw({ type: 'application/json', limit: '50mb' }));

  // JSON body parser for all other routes with increased limit
  app.use(bodyParser.json({ limit: '50mb' }));
  app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

  app.setGlobalPrefix('api');
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

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { excludeExtraneousValues: false },
    })
  );

  await app.listen(process.env.PORT ?? 3000).then(() => {
    console.log(`Server started on port: ${process.env.PORT ?? 3000}`);
  });
}
bootstrap();
