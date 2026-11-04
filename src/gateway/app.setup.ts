import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** Global configuration shared by main.ts and the e2e tests. */
export const configureApp = (app: INestApplication): INestApplication => {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Permissions Gateway')
      .setDescription('HTTP gateway for the NATS permissions service')
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'ADMIN_TOKEN or SERVICE_TOKEN' })
      .build(),
  );
  SwaggerModule.setup('docs', app, document);

  return app;
};
