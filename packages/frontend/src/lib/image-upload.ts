export interface ImageCompressionOptions {
  maxDimension?: number;
  quality?: number;
  outputMimeType?: 'image/jpeg' | 'image/webp';
}

const DEFAULT_COMPRESSION: Required<ImageCompressionOptions> = {
  maxDimension: 1600,
  quality: 0.82,
  outputMimeType: 'image/jpeg',
};

const NON_COMPRESSIBLE_MIME_TYPES = new Set(['image/gif', 'image/svg+xml']);

function clampQuality(value: number): number {
  if (Number.isNaN(value)) return DEFAULT_COMPRESSION.quality;
  return Math.max(0, Math.min(1, value));
}

function getExtensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    default:
      return '';
  }
}

function getCompressedFileName(fileName: string, mimeType: string): string {
  const ext = getExtensionForMimeType(mimeType);
  if (!ext) return fileName;
  return fileName.replace(/\.[^.]+$/, '') + ext;
}

function toBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Image compression failed'));
        return;
      }
      resolve(blob);
    }, mimeType, quality);
  });
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new window.Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load image for compression'));
      img.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function isImageFile(file: File | null | undefined): file is File {
  return Boolean(file && file.type.startsWith('image/'));
}

export function getFirstImageFromClipboardData(clipboardData: DataTransfer | null): File | null {
  if (!clipboardData?.items) return null;

  for (const item of clipboardData.items) {
    if (!item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) return file;
  }

  return null;
}

export function getFirstImageFromFileList(files: FileList | null): File | null {
  if (!files) return null;

  for (const file of files) {
    if (isImageFile(file)) return file;
  }

  return null;
}

export async function compressImageForUpload(
  file: File,
  options: ImageCompressionOptions = {},
): Promise<File> {
  if (!isImageFile(file) || NON_COMPRESSIBLE_MIME_TYPES.has(file.type)) {
    return file;
  }

  const maxDimension = Math.max(1, Math.floor(options.maxDimension ?? DEFAULT_COMPRESSION.maxDimension));
  const quality = clampQuality(options.quality ?? DEFAULT_COMPRESSION.quality);
  const outputMimeType = options.outputMimeType ?? DEFAULT_COMPRESSION.outputMimeType;

  const image = await loadImage(file);
  let { width, height } = image;

  if (width > maxDimension || height > maxDimension) {
    const ratio = Math.min(maxDimension / width, maxDimension / height);
    width = Math.max(1, Math.round(width * ratio));
    height = Math.max(1, Math.round(height * ratio));
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is not supported in this browser');

  context.drawImage(image, 0, 0, width, height);
  const blob = await toBlob(canvas, outputMimeType, quality);
  const compressed = new File([blob], getCompressedFileName(file.name, outputMimeType), {
    type: outputMimeType,
    lastModified: Date.now(),
  });

  return compressed.size < file.size ? compressed : file;
}

export async function prepareImageForUpload(
  file: File,
  options?: ImageCompressionOptions,
): Promise<File> {
  if (!isImageFile(file)) return file;

  try {
    return await compressImageForUpload(file, options);
  } catch {
    return file;
  }
}
