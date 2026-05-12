import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { requirePermission } from '../middleware/rbac.js';
import { store } from '../db/index.js';
import { findFirstActiveTelegramBot } from '../db/repositories/telegram-bots-repository.js';
import { getFileInfo, buildFileUrl } from '../services/telegram.js';
import { sendMessage } from '../services/messages.js';
import { sendTelegramMedia } from '../services/telegram-outbound.js';
import { env } from '../config/env.js';
import { validateUploadedFile } from '../utils/file-validation.js';
import { isAgentConversationRecord } from '../services/conversation-scope.js';

// Ensure upload directory exists
function ensureUploadDir(): string {
  const uploadDir = path.resolve(env.UPLOAD_DIR);
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  return uploadDir;
}

// Map MIME types to message types
function mimeToMessageType(mime: string): 'image' | 'video' | 'document' | 'voice' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/ogg') || mime === 'audio/opus') return 'voice';
  return 'document';
}

export async function mediaRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  /**
   * GET /api/media/:messageId/:attachmentIndex
   *
   * Proxy a Telegram file attachment for display in the frontend.
   * Fetches the file from Telegram API using the stored fileId, caches locally,
   * and streams the result.
   */
  typedApp.get(
    '/api/media/:messageId/:attachmentIndex',
    {
      onRequest: [app.authenticate, requirePermission('messages:read')],
      schema: {
        tags: ['Media'],
        summary: 'Get media attachment by message ID and index',
        params: z.object({ messageId: z.uuid(), attachmentIndex: z.string() }),
      },
    },
    async (request, reply) => {
      const { messageId, attachmentIndex } = request.params;
      const index = parseInt(attachmentIndex, 10);

      // 1. Load the message
      const msg = store.getById('messages', messageId);

      if (!msg) {
        return reply.notFound('Message not found');
      }

      const messageConversation = store.getById('conversations', msg.conversationId as string);
      if (!messageConversation || isAgentConversationRecord(messageConversation)) {
        return reply.notFound('Message not found');
      }

      // 2. Extract attachment at index
      const attachments = msg.attachments as Record<string, unknown>[] | null;
      if (!attachments || !Array.isArray(attachments) || !attachments[index]) {
        return reply.notFound('Attachment not found');
      }

      const attachment = attachments[index] as Record<string, unknown>;
      const fileId = attachment.fileId as string | undefined;

      // For locally uploaded files, serve from disk
      if (attachment.localPath) {
        const localPath = attachment.localPath as string;
        const fullPath = path.resolve(localPath);

        // Path traversal protection: ensure the resolved path is within the upload directory
        const uploadDir = path.resolve(env.UPLOAD_DIR);
        if (!fullPath.startsWith(uploadDir)) {
          return reply.forbidden('Access denied: path traversal detected');
        }

        if (!fs.existsSync(fullPath)) {
          return reply.notFound('File not found on disk');
        }

        const mimeType = (attachment.mimeType as string) || 'application/octet-stream';
        const fileName = sanitizeFilename((attachment.fileName as string) || 'file');

        return reply
          .header('Content-Type', mimeType)
          .header('Content-Disposition', `inline; filename="${fileName}"`)
          .header('Cache-Control', 'private, max-age=3600')
          .send(fs.createReadStream(fullPath));
      }

      // For Telegram files, proxy via Telegram API
      if (!fileId) {
        return reply.notFound('No fileId on attachment');
      }

      // 3. Find an active Telegram bot to fetch the file
      const bot = await findFirstActiveTelegramBot();

      if (!bot) {
        return reply.serviceUnavailable('No active Telegram bot');
      }

      // 4. Check local cache first
      const uploadDir = ensureUploadDir();
      const cacheDir = path.join(uploadDir, 'telegram-cache');
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      const fileUniqueId = (attachment.fileUniqueId as string) || fileId;
      const cachedFiles = fs.readdirSync(cacheDir).filter((f) => f.startsWith(fileUniqueId));

      if (cachedFiles.length > 0) {
        const cachedPath = path.join(cacheDir, cachedFiles[0]);
        const mimeType = (attachment.mimeType as string) || guessMimeType(attachment);
        const fileName = (attachment.fileName as string) || cachedFiles[0];

        return reply
          .header('Content-Type', mimeType)
          .header('Content-Disposition', `inline; filename="${fileName}"`)
          .header('Cache-Control', 'private, max-age=86400')
          .send(fs.createReadStream(cachedPath));
      }

      // 5. Fetch file info from Telegram
      let fileInfo;
      try {
        fileInfo = await getFileInfo(bot.token as string, fileId);
      } catch (err) {
        app.log.error(err, 'Failed to get Telegram file info');
        return reply.serviceUnavailable('Failed to fetch file from Telegram');
      }

      if (!fileInfo.file_path) {
        return reply.serviceUnavailable('Telegram file_path not available');
      }

      // 6. Download from Telegram and cache
      const downloadUrl = buildFileUrl(bot.token as string, fileInfo.file_path);
      const ext = path.extname(fileInfo.file_path) || '';
      const cacheFileName = `${fileUniqueId}${ext}`;
      const cachePath = path.join(cacheDir, cacheFileName);

      try {
        const telegramRes = await fetch(downloadUrl);
        if (!telegramRes.ok || !telegramRes.body) {
          return reply.serviceUnavailable('Failed to download file from Telegram');
        }

        // Write to cache
        const fileStream = fs.createWriteStream(cachePath);
        await pipeline(telegramRes.body as unknown as NodeJS.ReadableStream, fileStream);
      } catch (err) {
        app.log.error(err, 'Failed to download/cache Telegram file');
        // Clean up partial file
        if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
        return reply.serviceUnavailable('Failed to download file from Telegram');
      }

      // 7. Stream the cached file
      const mimeType = (attachment.mimeType as string) || guessMimeType(attachment);
      const fileName = (attachment.fileName as string) || cacheFileName;

      return reply
        .header('Content-Type', mimeType)
        .header('Content-Disposition', `inline; filename="${fileName}"`)
        .header('Cache-Control', 'private, max-age=86400')
        .send(fs.createReadStream(cachePath));
    },
  );

  /**
   * POST /api/media/upload
   *
   * Upload a file and send it as a media message.
   * Accepts multipart form data with:
   *   - file: the file to upload
   *   - conversationId: target conversation UUID
   *   - caption: optional text caption
   */
  typedApp.post(
    '/api/media/upload',
    {
      onRequest: [app.authenticate, requirePermission('messages:send')],
      schema: {
        tags: ['Media'],
        summary: 'Upload a file and send as media message',
      },
    },
    async (request, reply) => {
      const data = await request.file();
      if (!data) {
        return reply.badRequest('No file uploaded');
      }

      // Validate file type before processing (OWASP Unrestricted File Upload)
      const uploadMimeType = data.mimetype || 'application/octet-stream';
      const uploadFilename = data.filename || 'unknown';
      const fileCheck = validateUploadedFile(uploadMimeType, uploadFilename);
      if (!fileCheck.valid) {
        return reply.badRequest(fileCheck.error!);
      }

      const conversationId = (data.fields.conversationId as { value: string } | undefined)?.value;
      const caption = (data.fields.caption as { value: string } | undefined)?.value || undefined;

      if (!conversationId) {
        return reply.badRequest('conversationId is required');
      }

      // Verify conversation exists
      const conversation = store.getById('conversations', conversationId);

      if (!conversation || isAgentConversationRecord(conversation)) {
        return reply.notFound('Conversation not found');
      }

      // Save file to disk
      const uploadDir = ensureUploadDir();
      const fileExt = path.extname(data.filename || '') || '';
      const uniqueName = `${crypto.randomUUID()}${fileExt}`;
      const filePath = path.join(uploadDir, uniqueName);

      await pipeline(data.file, fs.createWriteStream(filePath));

      // Determine message type from MIME
      const mimeType = data.mimetype || 'application/octet-stream';
      const msgType = mimeToMessageType(mimeType);

      // Build attachment metadata
      const attachment = {
        type: msgType === 'image' ? 'photo' : msgType,
        fileName: data.filename || uniqueName,
        mimeType,
        fileSize: fs.statSync(filePath).size,
        localPath: filePath,
      };

      // Store message in DB
      const message = await sendMessage(
        {
          conversationId,
          senderId: request.user.sub,
          direction: 'outbound',
          type: msgType,
          content: caption,
          attachments: [attachment],
        },
        {
          userId: request.user.sub,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        },
      );

      if (!message) {
        return reply.internalServerError('Failed to store message');
      }

      // If Telegram conversation, send media via Telegram in background
      if (conversation.channelType === 'telegram') {
        sendTelegramMedia({
          conversationId,
          messageId: message.id as string,
          filePath,
          fileName: data.filename || uniqueName,
          mimeType,
          type: msgType,
          caption,
        }).catch((err) => {
          app.log.error(err, 'Failed to send Telegram media');
        });
      }

      return reply.status(201).send(message);
    },
  );
}

/**
 * Sanitize filename for Content-Disposition header to prevent header injection.
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[^\w\s.\-()]/g, '_') // Replace special chars
    .replace(/\.{2,}/g, '.') // Collapse consecutive dots
    .slice(0, 255); // Limit length
}

/**
 * Guess MIME type from attachment metadata.
 */
function guessMimeType(attachment: Record<string, unknown>): string {
  const type = attachment.type as string | undefined;
  const mime = attachment.mimeType as string | undefined;

  if (mime) return mime;

  switch (type) {
    case 'photo':
      return 'image/jpeg';
    case 'video':
      return 'video/mp4';
    case 'voice':
      return 'audio/ogg';
    case 'audio':
      return 'audio/mpeg';
    case 'sticker':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}
