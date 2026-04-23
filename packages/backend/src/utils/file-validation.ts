/**
 * File upload validation (OWASP Unrestricted File Upload).
 *
 * Strict uploads use a MIME allowlist.
 * Relaxed uploads still block executable/script-like files by extension and MIME.
 */

const ALLOWED_MIME_TYPES = new Set([
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/tiff',

  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',

  // Video
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',

  // Audio / voice
  'audio/mpeg',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/webm',
  'audio/mp4',

  // Archives (common for document sharing)
  'application/zip',
  'application/x-rar-compressed',
  'application/gzip',
]);

const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.pif',
  '.sh', '.bash', '.csh', '.ksh',
  '.ps1', '.psm1', '.psd1',
  '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.dll', '.so', '.dylib',
  '.php', '.php3', '.php4', '.php5', '.phtml',
  '.asp', '.aspx', '.jsp', '.cgi',
  '.py', '.pyc', '.pyo',
  '.rb', '.pl',
  '.htaccess', '.htpasswd',
]);

const BLOCKED_MIME_TYPES = new Set([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-ms-installer',
  'application/x-msi',
  'application/x-bat',
  'application/x-csh',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-executable',
  'application/x-mach-binary',
  'application/x-dosexec',
  'application/x-httpd-php',
  'application/x-php',
  'application/javascript',
  'text/javascript',
]);

export interface FileValidationResult {
  valid: boolean;
  error?: string;
}

export interface UploadedFileValidationOptions {
  mode?: 'strict' | 'nonExecutable';
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export function validateUploadedFile(
  mimeType: string,
  filename: string,
  options: UploadedFileValidationOptions = {},
): FileValidationResult {
  const mode = options.mode ?? 'strict';
  const normalizedMimeType = normalizeMimeType(mimeType);

  if (mode === 'strict') {
    if (!ALLOWED_MIME_TYPES.has(normalizedMimeType)) {
      return {
        valid: false,
        error: `File type "${mimeType}" is not allowed`,
      };
    }
  } else if (normalizedMimeType && BLOCKED_MIME_TYPES.has(normalizedMimeType)) {
    return {
      valid: false,
      error: `File type "${mimeType}" is not allowed`,
    };
  }

  // Check file extension against blocklist
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      error: `File extension "${ext}" is not allowed`,
    };
  }

  return { valid: true };
}
