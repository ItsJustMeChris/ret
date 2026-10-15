/**
 * Computer-use screenshots, decoded off the main thread: the base64 a step carries becomes the
 * image itself and a copy `width` wide for docks and thumbnails. Decoding and scaling a 1600×900
 * PNG takes ~12 ms, which on the main thread shows as dropped frames while an agent works.
 */
export interface ShotJob {
  id: string;
  data: string;
  mime: string;
  width: number;
}

export interface ShotDone {
  id: string;
  /** The image as sent (null: it didn't decode). */
  full: Blob | null;
  /** The smaller copy (null: the image is no wider than that already, or it didn't decode). */
  thumb: Blob | null;
}

const scope = self as unknown as { onmessage: ((e: MessageEvent<ShotJob>) => void) | null; postMessage(m: ShotDone): void };

scope.onmessage = async ({ data: { id, data, mime, width } }) => {
  let full: Blob | null = null;
  let thumb: Blob | null = null;
  try {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    full = new Blob([bytes], { type: mime });
    const bmp = await createImageBitmap(full);
    if (bmp.width > width) {
      const canvas = new OffscreenCanvas(width, Math.round((bmp.height * width) / bmp.width));
      canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      thumb = await canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
    }
    bmp.close();
  } catch {
    // Whatever decoded is still worth showing: without a copy, views use the image as sent.
  }
  scope.postMessage({ id, full, thumb });
};
