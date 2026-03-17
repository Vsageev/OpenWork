import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

export async function registerSwagger(app: FastifyInstance) {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'OpenWork API',
        description:
          'Public REST API for the OpenWork platform. Provides access to cards, boards, folders, and messages.\n\n' +
          '## Authentication\n\n' +
          'All endpoints require a `Bearer` token in the `Authorization` header. Two authentication methods are supported:\n\n' +
          '- **JWT Token** — Obtained via `/api/auth/login`. Use `Authorization: Bearer <jwt>`.\n' +
          '- **API Key** — Generated in the OpenWork settings. API keys are prefixed with `ws_`. Use `Authorization: Bearer ws_<key>`.\n\n' +
          'API keys have scoped permissions — only the permissions granted to the key will be available.\n\n' +
          '## Pagination\n\n' +
          'List endpoints support `limit` (1–100, default 50) and `offset` (default 0) query parameters.\n\n' +
          '## Ownership Scoping\n\n' +
          'Some endpoints scope data to the authenticated user.\n\n' +
          '## Errors\n\n' +
          'Errors follow a consistent format with `statusCode`, `error`, and `message` fields.',
        version: '1.0.0',
        contact: { name: 'OpenWork Support' },
      },
      servers: [{ url: '/', description: 'Current server' }],
      tags: [
        { name: 'Health', description: 'Health check' },
        { name: 'Auth', description: 'Authentication and 2FA' },
        { name: 'Contacts', description: 'Manage contacts' },
        { name: 'Cards', description: 'Manage cards on boards' },
        { name: 'Boards', description: 'Manage boards and columns' },
        { name: 'Folders', description: 'Manage folders for organizing items' },
        { name: 'Tags', description: 'Manage tags for contacts and cards' },
        { name: 'Conversations', description: 'Manage conversations' },
        { name: 'Messages', description: 'Send and retrieve messages within conversations' },
        { name: 'Telegram', description: 'Telegram bot integration' },
        { name: 'Connectors', description: 'External service connectors' },
        { name: 'Storage', description: 'File storage management' },
        { name: 'Audit Logs', description: 'System audit logs' },
        { name: 'Media', description: 'File uploads and media management' },
        { name: 'Widget', description: 'Embeddable website widget' },
        { name: 'API Keys', description: 'API key management' },
        { name: 'Webhooks', description: 'Webhook management' },
        { name: 'Backup', description: 'Data backup and restore' },
        { name: 'AI', description: 'AI-powered features' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT or API Key (ws_...)',
            description: 'JWT token or API key prefixed with ws_',
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      persistAuthorization: true,
    },
  });
}
