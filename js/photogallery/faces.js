/* ==========================================================================
   photo-gallery admin — face detection
   --------------------------------------------------------------------------
   Detection runs entirely in the browser via face-api.js. The 128-float
   descriptors are stored in Postgres as vector(128) and matched there (the
   gallery_match_face / gallery_resuggest RPCs), so no photo and no face
   embedding is ever sent to another company.

   THE COORDINATE CONTRACT — this is the bug the v2 schema was designed to
   fix, and the reason the old client stored garbage:

     The detector reports boxes in pixels of WHATEVER SURFACE WE DETECTED ON.
     We always divide by that surface's own dimensions and store fractions
     0..1. Cropping then multiplies fractions by the *displayed* image's
     natural size. Because both ends are relative, it no longer matters which
     rendition was scanned or which is shown.

   The old code detected on the 400px thumbnail, stored the raw thumbnail
   pixels, and cropped from the full-size original — three mismatched spaces.
   The server's parseBox also requires fractions, so every box it sent was
   rejected outright.

   We detect on a ~1000px render of the full image: a 400px thumb of a group
   shot gives the detector a ~25px face, which is enough to notice but not
   enough for a usable descriptor, so recognition quality would have been poor
   even if the old calls had worked.
   ========================================================================== */

import { renderToCanvas, decode, loadImage } from "./imaging.js";

/** Long edge we detect against. Fixed cost per photo regardless of source. */
export const DETECT_EDGE = 1000;

const FACE_API_SRC = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/dist/face-api.min.js";
const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model";

let scriptPromise = null;
let modelsPromise = null;

/**
 * Load face-api.js and its three nets, once per session.
 *
 * Lazy on purpose: this is ~1 MB of script plus ~6 MB of model weights, and
 * the previous admin page fetched it in a <script> tag on every page load
 * even if nobody went near face tagging.
 */
export function loadFaceApi(onProgress) {
  if (modelsPromise) return modelsPromise;

  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      if (window.faceapi) { resolve(); return; }
      if (onProgress) onProgress("Loading the face recognition library…");
      const script = document.createElement("script");
      script.src = FACE_API_SRC;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(
        "Could not load the face recognition library. Check your connection and try again."));
      document.head.append(script);
    });
  }

  modelsPromise = scriptPromise.then(async () => {
    if (!window.faceapi) throw new Error("The face recognition library did not load.");
    if (onProgress) onProgress("Loading face recognition models (about 6 MB, once per session)…");
    await Promise.all([
      window.faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      window.faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      window.faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
    if (onProgress) onProgress("");
  }).catch((err) => {
    // Let a later attempt retry rather than caching the failure forever.
    modelsPromise = null;
    scriptPromise = null;
    throw err;
  });

  return modelsPromise;
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/**
 * Detector pixels → fractions of the image.
 *
 * Clamped into 0..1 and trimmed so x+w and y+h can't exceed 1: the detector
 * happily returns boxes that hang off the edge of the frame, and the server's
 * CHECK constraints reject those.
 */
export function toFractionBox(box, surfaceWidth, surfaceHeight) {
  const x = clamp01(box.x / surfaceWidth);
  const y = clamp01(box.y / surfaceHeight);
  return {
    x,
    y,
    w: clamp01(Math.min(box.width / surfaceWidth, 1 - x)),
    h: clamp01(Math.min(box.height / surfaceHeight, 1 - y)),
  };
}

/** Fractions → pixels of a given rendition, for overlays. */
export function toPixelBox(box, width, height) {
  return { x: box.x * width, y: box.y * height, w: box.w * width, h: box.h * height };
}

function detectorOptions() {
  return new window.faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.45 });
}

/**
 * Detect every face in one image.
 *
 * @param {string} imageUrl full-size image URL (not the thumbnail)
 * @returns {Promise<Array<{embedding: number[], box: {x,y,w,h}, det_score: number, detector: string}>>}
 */
export async function detectFaces(imageUrl) {
  const img = await loadImage(imageUrl);
  const { canvas, width, height } = renderToCanvas(img, DETECT_EDGE);
  const detections = await window.faceapi
    .detectAllFaces(canvas, detectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptors();

  return (detections || []).map((det) => ({
    embedding: Array.from(det.descriptor),
    box: toFractionBox(det.detection.box, width, height),
    det_score: typeof det.detection.score === "number" ? det.detection.score : null,
    detector: "tiny_face_detector",
  }));
}

/**
 * Compute a descriptor for a hand-drawn box (for face-add-manual).
 *
 * Runs the detector on the cropped region rather than trusting the drawn
 * rectangle: face-add-manual needs a real 128-float embedding, and a box the
 * user drew around, say, a hat would otherwise poison that person's exemplars.
 * Returns null when there's no face inside the box, so the caller can offer a
 * plain photo tag instead.
 *
 * @param {string} imageUrl
 * @param {{x,y,w,h}} box fractions of the image
 */
export async function describeBox(imageUrl, box) {
  const img = await loadImage(imageUrl);
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;

  // A little context around the box helps the landmark model considerably.
  const pad = 0.25;
  const px = Math.max(0, (box.x - box.w * pad) * iw);
  const py = Math.max(0, (box.y - box.h * pad) * ih);
  const pw = Math.min(iw - px, box.w * (1 + pad * 2) * iw);
  const ph = Math.min(ih - py, box.h * (1 + pad * 2) * ih);
  if (pw < 24 || ph < 24) return null;

  const canvas = document.createElement("canvas");
  // Upscale small crops — the recognition net wants a reasonable input size.
  const scale = Math.max(1, 240 / Math.min(pw, ph));
  canvas.width = Math.round(pw * scale);
  canvas.height = Math.round(ph * scale);
  canvas.getContext("2d").drawImage(img, px, py, pw, ph, 0, 0, canvas.width, canvas.height);

  const det = await window.faceapi
    .detectSingleFace(canvas, detectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!det) return null;
  return { embedding: Array.from(det.descriptor), det_score: det.detection.score ?? null };
}

/**
 * Detect on an already-decoded File (used when a manual box is drawn on a
 * local file rather than a stored photo).
 */
export async function detectInFile(file) {
  const source = await decode(file);
  try {
    const { canvas, width, height } = renderToCanvas(source, DETECT_EDGE);
    const detections = await window.faceapi
      .detectAllFaces(canvas, detectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptors();
    return (detections || []).map((det) => ({
      embedding: Array.from(det.descriptor),
      box: toFractionBox(det.detection.box, width, height),
      det_score: det.detection.score ?? null,
      detector: "tiny_face_detector",
    }));
  } finally {
    if (source.close) source.close();
  }
}

/**
 * Plain-English confidence from the L2 distance the matcher returns. The
 * number is always shown alongside — never colour or wording alone.
 */
export function confidenceLabel(distance) {
  if (distance == null) return "No suggestion";
  if (distance <= 0.36) return "Very likely";
  if (distance <= 0.46) return "Likely";
  if (distance <= 0.54) return "Possible";
  return "Uncertain";
}
