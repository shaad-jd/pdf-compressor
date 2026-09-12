/**
 * image-handler.js
 * Validates and reads JPG, PNG, and WEBP images.
 * Everything runs locally in the browser.
 */

const IMAGE_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
const IMAGE_LARGE_FILE_WARNING_BYTES = 25 * 1024 * 1024; // 25 MB

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp'
]);

const SUPPORTED_IMAGE_EXTENSIONS = /\.(jpe?g|png|webp)$/i;

/**
 * Validates an image before processing.
 * The browser must successfully decode the image,
 * so extension/MIME type alone is never trusted.
 *
 * Returns:
 * {
 *   valid: boolean,
 *   reason?: string,
 *   width?: number,
 *   height?: number,
 *   isLarge?: boolean
 * }
 */
async function validateImageFile(file) {
  if (!file) {
    return { valid: false, reason: 'No file was selected.' };
  }

  if (file.size === 0) {
    return { valid: false, reason: 'This file is empty.' };
  }

  if (file.size > IMAGE_MAX_FILE_SIZE_BYTES) {
    return {
      valid: false,
      reason: 'This file is larger than the 100 MB limit supported in this version.'
    };
  }

  const name = file.name || '';
  const hasSupportedExtension = SUPPORTED_IMAGE_EXTENSIONS.test(name);
  const hasSupportedMime = SUPPORTED_IMAGE_TYPES.has(file.type);

  if (!hasSupportedExtension && !hasSupportedMime) {
    return {
      valid: false,
      reason: 'This doesn’t appear to be a supported image. Use JPG, PNG, or WEBP.'
    };
  }

  let imageUrl = null;

  try {
    imageUrl = URL.createObjectURL(file);

    const image = await loadImage(imageUrl);

    if (!image.naturalWidth || !image.naturalHeight) {
      return {
        valid: false,
        reason: 'This image has invalid dimensions.'
      };
    }

    return {
      valid: true,
      width: image.naturalWidth,
      height: image.naturalHeight,
      isLarge: file.size > IMAGE_LARGE_FILE_WARNING_BYTES
    };
  } catch (_) {
    return {
      valid: false,
      reason: 'This image could not be decoded. It may be corrupted or unsupported.'
    };
  } finally {
    if (imageUrl) {
      URL.revokeObjectURL(imageUrl);
    }
  }
}

/**
 * Loads an image using the browser's native decoder.
 */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();

    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Image decoding failed.'));

    image.src = url;
  });
}

/**
 * Reads an image into a canvas.
 * This will be used by the compression pipeline later.
 */
async function loadImageToCanvas(file) {
  const imageUrl = URL.createObjectURL(file);

  try {
    const image = await loadImage(imageUrl);

    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;

    const ctx = canvas.getContext('2d');

    if (!ctx) {
      throw new Error('Canvas is not supported in this browser.');
    }

    ctx.drawImage(image, 0, 0);

    return {
      canvas,
      width: image.naturalWidth,
      height: image.naturalHeight
    };
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

/**
 * Converts a canvas into a Blob using the browser's
 * native image encoder.
 */
function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => {
        if (!blob) {
          reject(new Error('The browser could not encode this image.'));
          return;
        }

        resolve(blob);
      },
      type,
      quality
    );
  });
}
/**
 * Compresses an image toward a target size.
 *
 * JPG/WEBP:
 * - Uses image quality to reduce size.
 *
 * PNG:
 * - Uses resizing because PNG quality settings are not
 *   reliably supported by browser canvas encoders.
 *
 * Returns:
 * {
 *   blob,
 *   size,
 *   width,
 *   height,
 *   type
 * }
 */
async function compressImageToTarget(file, targetBytes, onProgress) {
  const loaded = await loadImageToCanvas(file);

  let canvas = loaded.canvas;
  let width = loaded.width;
  let height = loaded.height;

  const originalType = file.type || 'image/jpeg';
  const outputType = originalType === 'image/png'
    ? 'image/png'
    : originalType === 'image/webp'
      ? 'image/webp'
      : 'image/jpeg';

  const report = (percent, detail) => {
    if (typeof onProgress === 'function') {
      onProgress(percent, detail);
    }
  };

  report(10, 'Preparing image…');

  // If the original is already at or below the target,
  // return it without unnecessary recompression.
  if (file.size <= targetBytes) {
    report(100, 'Image is already within the target size.');

    return {
      blob: file,
      size: file.size,
      width,
      height,
      type: file.type || outputType
    };
  }

  /*
   * Lossy formats: first try quality reduction.
   */
  if (outputType !== 'image/png') {
    let bestBlob = null;
    let bestQuality = 0.1;

    let low = 0.1;
    let high = 0.95;

    for (let i = 0; i < 8; i++) {
      const quality = (low + high) / 2;

      const blob = await canvasToBlob(
        canvas,
        outputType,
        quality
      );

      report(
        15 + (i / 8) * 55,
        `Testing image quality: ${Math.round(quality * 100)}%`
      );

      if (blob.size <= targetBytes) {
        bestBlob = blob;
        bestQuality = quality;
        low = quality;
      } else {
        high = quality;
      }
    }

    if (bestBlob) {
      report(100, 'Target size reached.');

      return {
        blob: bestBlob,
        size: bestBlob.size,
        width,
        height,
        type: outputType,
        quality: bestQuality
      };
    }
  }

  /*
   * If quality alone isn't enough, gradually reduce dimensions.
   */
  let scale = 0.9;
  let bestBlob = null;
  let bestWidth = width;
  let bestHeight = height;

  for (let i = 0; i < 8; i++) {
    const newWidth = Math.max(1, Math.round(width * scale));
    const newHeight = Math.max(1, Math.round(height * scale));

    const resizedCanvas = document.createElement('canvas');
    resizedCanvas.width = newWidth;
    resizedCanvas.height = newHeight;

    const ctx = resizedCanvas.getContext('2d');

    if (!ctx) {
      throw new Error('Canvas is not supported in this browser.');
    }

    ctx.drawImage(canvas, 0, 0, newWidth, newHeight);

    const quality = outputType === 'image/png' ? undefined : 0.75;

    const blob = await canvasToBlob(
      resizedCanvas,
      outputType,
      quality
    );

    report(
      70 + (i / 8) * 25,
      `Reducing image dimensions: ${newWidth} × ${newHeight}`
    );

    if (blob.size <= targetBytes) {
      bestBlob = blob;
      bestWidth = newWidth;
      bestHeight = newHeight;
      break;
    }

    canvas = resizedCanvas;
    scale *= 0.85;
  }

  if (!bestBlob) {
    throw new Error('Target image size could not be reached safely.');
  }

  report(100, 'Target size reached.');

  return {
    blob: bestBlob,
    size: bestBlob.size,
    width: bestWidth,
    height: bestHeight,
    type: outputType
  };
}