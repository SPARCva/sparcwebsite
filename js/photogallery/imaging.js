/* ==========================================================================
   photo-gallery admin — client-side image work
   --------------------------------------------------------------------------
   There is no server-side image processing anywhere in this stack: the edge
   function never touches image bytes on upload (the browser PUTs straight to
   storage against signed URLs), so resizing and thumbnailing happen here.

   Three jobs:
     1. resize()    — cap the long edge at 2000px for the stored original
     2. thumbnail() — 400px JPEG for grids and the public gallery
     3. takenAt()   — EXIF DateTimeOriginal, so the featured scroll stays in
                      chronological order through an event day

   The EXIF reader is ported from the previous admin page, which walked JPEG
   APP1 → TIFF header → IFD0 → ExifIFD by hand rather than pulling in a
   library. It works and it's tiny; it is kept as-is apart from being promise
   -shaped and reading a slightly larger prefix.
   ========================================================================== */

/** Long-edge cap for the stored original. Matches the function's README. */
export const MAX_EDGE = 2000;
/** Long-edge cap for thumbnails. Storage path is <gallery>/<year>/thumbs/. */
export const THUMB_EDGE = 400;

/* ---------- decoding --------------------------------------------------- */

/**
 * Decode a File/Blob to something drawable. createImageBitmap is both faster
 * and (importantly) applies EXIF orientation when asked, so portrait phone
 * photos don't come out sideways — a plain <img> in Safari historically did
 * not. Falls back to an <img> where it's unavailable.
 */
export async function decode(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch { /* fall through to the <img> path */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not read that image."));
      img.src = url;
    });
  } finally {
    // Revoking immediately is safe: the decode has already completed.
    URL.revokeObjectURL(url);
  }
}

/** Load a cross-origin image (our storage bucket) for canvas reads. */
export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // The bucket is public-read and serves permissive CORS, so the canvas
    // stays untainted and getImageData / toBlob keep working.
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load the image."));
    img.src = url;
  });
}

function dimensions(source) {
  return {
    width: source.width || source.naturalWidth || 0,
    height: source.height || source.naturalHeight || 0,
  };
}

/** Scale factor that fits the long edge into `maxEdge`, never upscaling. */
function scaleFor(width, height, maxEdge) {
  const longest = Math.max(width, height);
  return longest > maxEdge ? maxEdge / longest : 1;
}

/* ---------- rendering ------------------------------------------------- */

/**
 * Draw `source` into a canvas capped at `maxEdge`. Returns the canvas plus
 * the dimensions actually used, which callers need: the face detector reports
 * boxes in rendered pixels and we store them as fractions of the image.
 */
export function renderToCanvas(source, maxEdge) {
  const { width, height } = dimensions(source);
  const scale = scaleFor(width, height, maxEdge);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, w, h);
  return { canvas, width: w, height: h, sourceWidth: width, sourceHeight: height };
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the image."))),
      type,
      quality,
    );
  });
}

/**
 * Resize for storage. PNGs keep their format (they're usually graphics with
 * flat colour or transparency, which JPEG would wreck); everything else is
 * encoded as JPEG.
 *
 * If the image is already within the cap and is a JPEG, the original File is
 * returned untouched — no point re-encoding and losing quality for nothing.
 *
 * @returns {{blob: Blob, width: number, height: number, contentType: string}}
 */
export async function resize(file, maxEdge = MAX_EDGE) {
  const source = await decode(file);
  const { width, height } = dimensions(source);

  const isPng = /png/i.test(file.type);
  const isJpeg = /jpe?g/i.test(file.type);
  const contentType = isPng ? "image/png" : "image/jpeg";

  if (scaleFor(width, height, maxEdge) === 1 && isJpeg) {
    if (source.close) source.close();
    return { blob: file, width, height, contentType: file.type || "image/jpeg" };
  }

  const render = renderToCanvas(source, maxEdge);
  if (source.close) source.close();
  const blob = await canvasToBlob(render.canvas, contentType, isPng ? undefined : 0.9);
  return { blob, width: render.width, height: render.height, contentType };
}

/**
 * 400px JPEG thumbnail. Always JPEG — thumbnails are always photographic
 * enough that the size win beats PNG fidelity.
 */
export async function thumbnail(file, maxEdge = THUMB_EDGE) {
  const source = await decode(file);
  const render = renderToCanvas(source, maxEdge);
  if (source.close) source.close();
  const blob = await canvasToBlob(render.canvas, "image/jpeg", 0.8);
  return { blob, width: render.width, height: render.height, contentType: "image/jpeg" };
}

/**
 * Both renders from a single decode. Decoding a 12MP photo twice is the
 * expensive part of a 200-photo batch, so the uploader uses this.
 */
export async function renderPair(file, maxEdge = MAX_EDGE, thumbEdge = THUMB_EDGE) {
  const source = await decode(file);
  try {
    const { width, height } = dimensions(source);
    const isPng = /png/i.test(file.type);
    const isJpeg = /jpe?g/i.test(file.type);
    const mainType = isPng ? "image/png" : "image/jpeg";

    let main;
    if (scaleFor(width, height, maxEdge) === 1 && isJpeg) {
      main = { blob: file, width, height, contentType: file.type || "image/jpeg" };
    } else {
      const render = renderToCanvas(source, maxEdge);
      main = {
        blob: await canvasToBlob(render.canvas, mainType, isPng ? undefined : 0.9),
        width: render.width,
        height: render.height,
        contentType: mainType,
      };
    }

    const thumbRender = renderToCanvas(source, thumbEdge);
    const thumb = {
      blob: await canvasToBlob(thumbRender.canvas, "image/jpeg", 0.8),
      width: thumbRender.width,
      height: thumbRender.height,
      contentType: "image/jpeg",
    };

    return { main, thumb };
  } finally {
    if (source.close) source.close();
  }
}

/* ---------- EXIF capture date ----------------------------------------- */

/** Last-resort date: the file's own mtime. */
function fallbackDate(file) {
  return file.lastModified ? new Date(file.lastModified).toISOString() : null;
}

/**
 * Read the JPEG capture date.
 *
 * Walks the JPEG segment list for APP1 (0xFFE1), verifies the "Exif" magic,
 * reads the TIFF header for endianness, finds the Exif sub-IFD pointer
 * (tag 0x8769) in IFD0, then looks for DateTimeOriginal (0x9003) or
 * DateTimeDigitized (0x9004). EXIF stores these as "YYYY:MM:DD HH:MM:SS"
 * with no zone, so it's reassembled into a naive ISO string — the same shape
 * the previous implementation produced and what the function stores.
 *
 * @returns {Promise<string|null>}
 */
export function takenAt(file) {
  if (!/jpe?g/i.test(file.type)) return Promise.resolve(fallbackDate(file));

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(fallbackDate(file));
    reader.onload = (event) => {
      try {
        const view = new DataView(event.target.result);
        if (view.getUint16(0) !== 0xFFD8) return resolve(fallbackDate(file));

        let off = 2;
        const len = view.byteLength;
        while (off < len) {
          const marker = view.getUint16(off);
          off += 2;
          if (marker === 0xFFE1) {
            if (view.getUint32(off + 2) !== 0x45786966) return resolve(fallbackDate(file));
            const tiff = off + 8;
            const little = view.getUint16(tiff) === 0x4949;
            const u16 = (o) => view.getUint16(o, little);
            const u32 = (o) => view.getUint32(o, little);

            const ifd0 = tiff + u32(tiff + 4);
            const count0 = u16(ifd0);
            let exifIFD = null;
            for (let i = 0; i < count0; i++) {
              const entry = ifd0 + 2 + i * 12;
              if (u16(entry) === 0x8769) exifIFD = tiff + u32(entry + 8);
            }
            if (exifIFD) {
              const count = u16(exifIFD);
              for (let j = 0; j < count; j++) {
                const entry = exifIFD + 2 + j * 12;
                const tag = u16(entry);
                if (tag === 0x9003 || tag === 0x9004) {
                  const chars = u32(entry + 4);
                  const valueOff = tiff + u32(entry + 8);
                  let text = "";
                  for (let k = 0; k < chars - 1; k++) text += String.fromCharCode(view.getUint8(valueOff + k));
                  const m = text.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
                  if (m) return resolve(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
                }
              }
            }
            return resolve(fallbackDate(file));
          } else if ((marker & 0xFF00) !== 0xFF00) {
            break;   // not a marker — we've walked off the segment list
          } else {
            off += view.getUint16(off);
          }
        }
        resolve(fallbackDate(file));
      } catch {
        resolve(fallbackDate(file));
      }
    };
    // 256 KB covers the EXIF block on every camera and phone we've seen;
    // reading the whole file would mean holding 200 photos in memory.
    reader.readAsArrayBuffer(file.slice(0, 262144));
  });
}

/* ---------- face crops ------------------------------------------------- */

/**
 * Draw a padded crop of a face box onto a canvas.
 *
 * `box` is fractions of the image (0..1), which is how v2 stores them — so
 * this works against the thumbnail or the full-size original, at any display
 * size. The previous code stored pixel boxes measured on the 400px thumbnail
 * and then cropped from the full-size image, so every crop was wrong.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLImageElement} img
 * @param {{x:number,y:number,w:number,h:number}} box
 * @param {number} pad fraction of the box size to include around it
 */
export function drawFaceCrop(canvas, img, box, pad = 0.4) {
  const ctx = canvas.getContext("2d");
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!box || !iw || !ih) {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return;
  }

  const bw = box.w * iw;
  const bh = box.h * ih;
  // Pad by the larger edge so the crop stays square-ish and doesn't stretch.
  const padPx = Math.max(bw, bh) * pad;
  let x = box.x * iw - padPx;
  let y = box.y * ih - padPx;
  let w = bw + padPx * 2;
  let h = bh + padPx * 2;

  // Clamp into the image without changing the requested size where possible.
  x = Math.max(0, Math.min(x, iw - Math.min(w, iw)));
  y = Math.max(0, Math.min(y, ih - Math.min(h, ih)));
  w = Math.min(w, iw - x);
  h = Math.min(h, ih - y);
  if (w <= 0 || h <= 0) {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return;
  }
  ctx.drawImage(img, x, y, w, h, 0, 0, canvas.width, canvas.height);
}

/**
 * A face crop as a data URL, for <img src>. Cached by the caller where it
 * matters — the triage queue prefetches the next few.
 */
export async function faceCropUrl(imageUrl, box, size = 320) {
  const img = await loadImage(imageUrl);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  drawFaceCrop(canvas, img, box);
  return canvas.toDataURL("image/jpeg", 0.85);
}
