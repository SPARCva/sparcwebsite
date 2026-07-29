/* ==========================================================================
   photo-gallery admin — ArcFace recognizer (Tier 3, opt-in)
   --------------------------------------------------------------------------
   A higher-accuracy face *recognizer* than face-api's 128-float descriptor.
   ArcFace produces 512-float embeddings compared by COSINE distance and is
   markedly better at telling similar-looking people apart.

   This module owns ONLY the descriptor. Detection and 68-point landmarks stay
   with face-api (faces.js) — we reuse them here for alignment. So the pipeline
   is: face-api detects a face and its landmarks → we align the face to the
   ArcFace canonical 112×112 pose → ArcFace produces the 512-float embedding.

   Alignment matters: ArcFace was trained on faces warped so the eyes, nose and
   mouth sit at fixed positions. Feeding it an un-aligned crop measurably hurts
   accuracy, so we compute a similarity transform (Umeyama) from five landmarks
   to the standard template and warp before inference.

   Runs entirely in the browser; no image or embedding leaves this origin. The
   model weights are vendored alongside face-api (see MODEL_URL) for the same
   reason — so face tagging keeps working at an event on unreliable wifi and no
   third-party request is made while handling constituents' photos.
   ========================================================================== */

import { loadImage } from "./imaging.js";

// Vendored TFJS graph model (ArcFace / InsightFace w600k or r50). See the
// README in that folder for how the weights were produced and vendored.
const MODEL_URL = "/js/photogallery/faceapi/arcface/model.json";

// ArcFace input is a 112×112 face aligned so these five landmarks land here
// (the standard InsightFace template, in pixels of the 112×112 tile):
//   left eye · right eye · nose tip · left mouth corner · right mouth corner
const TEMPLATE = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];
const ALIGN_SIZE = 112;

let modelPromise = null;

/** face-api bundles TensorFlow.js; reuse it rather than loading a second copy. */
function tf() {
  const t = window.faceapi && window.faceapi.tf;
  if (!t) throw new Error("Face library not ready. Open the scan panel once first.");
  return t;
}

/**
 * Load the ArcFace model once per session. Assumes face-api itself is already
 * loaded (loadFaceApi() in faces.js), since we borrow its TFJS and landmark net.
 */
export function loadArcFace(onProgress) {
  if (modelPromise) return modelPromise;
  if (onProgress) onProgress("Loading the high-accuracy face model (about 90 MB, once per session)…");
  modelPromise = tf().loadGraphModel(MODEL_URL)
    .then((model) => { if (onProgress) onProgress(""); return model; })
    .catch((err) => {
      modelPromise = null;
      throw new Error(
        "Could not load the high-accuracy face model. It may not be vendored yet — " +
        "see js/photogallery/faceapi/arcface/README.md. (" + (err.message || err) + ")");
    });
  return modelPromise;
}

/** True once the model is cached this session (cheap check for the UI). */
export function arcFaceReady() {
  return modelPromise !== null;
}

/* ---------- alignment maths ------------------------------------------------ */

/** Mean of a set of face-api landmark points ({x,y}). */
function centroid(points) {
  let x = 0, y = 0;
  for (const p of points) { x += p.x; y += p.y; }
  return { x: x / points.length, y: y / points.length };
}

/**
 * Five alignment points from face-api's 68-point landmarks:
 * eye centres (averaged over each eye), nose tip, and the two mouth corners.
 */
function fivePoints(landmarks) {
  const pts = landmarks.positions;
  const leftEye = centroid(pts.slice(36, 42));
  const rightEye = centroid(pts.slice(42, 48));
  const nose = pts[30];
  const mouthL = pts[48];
  const mouthR = pts[54];
  return [
    [leftEye.x, leftEye.y],
    [rightEye.x, rightEye.y],
    [nose.x, nose.y],
    [mouthL.x, mouthL.y],
    [mouthR.x, mouthR.y],
  ];
}

/**
 * Umeyama similarity transform (rotation + uniform scale + translation) mapping
 * `src` points onto `dst` points, least-squares. Returns the 2×3 affine
 * [a, b, tx, c, d, ty] usable directly with canvas setTransform(a,c,b,d,tx,ty).
 * This is the standard face-alignment estimator; kept small and dependency-free.
 */
function umeyama(src, dst) {
  const n = src.length;
  const meanSrc = [0, 0], meanDst = [0, 0];
  for (let i = 0; i < n; i++) {
    meanSrc[0] += src[i][0]; meanSrc[1] += src[i][1];
    meanDst[0] += dst[i][0]; meanDst[1] += dst[i][1];
  }
  meanSrc[0] /= n; meanSrc[1] /= n; meanDst[0] /= n; meanDst[1] /= n;

  let varSrc = 0;
  // 2×2 covariance of centred src→dst.
  let c00 = 0, c01 = 0, c10 = 0, c11 = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - meanSrc[0], sy = src[i][1] - meanSrc[1];
    const dx = dst[i][0] - meanDst[0], dy = dst[i][1] - meanDst[1];
    varSrc += sx * sx + sy * sy;
    c00 += dx * sx; c01 += dx * sy;
    c10 += dy * sx; c11 += dy * sy;
  }
  varSrc /= n;
  c00 /= n; c01 /= n; c10 /= n; c11 /= n;

  // SVD of the 2×2 covariance via its symmetric eigendecomposition.
  const { U, S, V } = svd2x2(c00, c01, c10, c11);
  // Reflection guard: keep a proper rotation (det = +1).
  const detUV = (U[0][0] * U[1][1] - U[0][1] * U[1][0]) * (V[0][0] * V[1][1] - V[0][1] * V[1][0]);
  const d = detUV < 0 ? [1, -1] : [1, 1];

  // R = U · diag(d) · Vᵀ
  const R = [
    [U[0][0] * d[0] * V[0][0] + U[0][1] * d[1] * V[0][1], U[0][0] * d[0] * V[1][0] + U[0][1] * d[1] * V[1][1]],
    [U[1][0] * d[0] * V[0][0] + U[1][1] * d[1] * V[0][1], U[1][0] * d[0] * V[1][0] + U[1][1] * d[1] * V[1][1]],
  ];
  const scale = varSrc > 0 ? (S[0] * d[0] + S[1] * d[1]) / varSrc : 1;

  const a = scale * R[0][0], b = scale * R[0][1];
  const c = scale * R[1][0], dd = scale * R[1][1];
  const tx = meanDst[0] - (a * meanSrc[0] + b * meanSrc[1]);
  const ty = meanDst[1] - (c * meanSrc[0] + dd * meanSrc[1]);
  return [a, b, tx, c, dd, ty];
}

/** SVD of a 2×2 matrix [[a,b],[c,d]] → { U, S:[s0,s1], V } (U,V rotations). */
function svd2x2(a, b, c, d) {
  const e = (a + d) / 2, f = (a - d) / 2, g = (c + b) / 2, h = (c - b) / 2;
  const q = Math.hypot(e, h), r = Math.hypot(f, g);
  const s0 = q + r, s1 = Math.abs(q - r);
  const a1 = Math.atan2(g, f), a2 = Math.atan2(h, e);
  const theta = (a2 - a1) / 2, phi = (a2 + a1) / 2;
  const U = [[Math.cos(phi), -Math.sin(phi)], [Math.sin(phi), Math.cos(phi)]];
  const V = [[Math.cos(theta), -Math.sin(theta)], [Math.sin(theta), Math.cos(theta)]];
  return { U, S: [s0, s1], V };
}

/* ---------- embedding ------------------------------------------------------ */

/** L2-normalise so cosine distance is a plain dot product downstream. */
function l2normalize(arr) {
  let sum = 0;
  for (const v of arr) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return arr.map((v) => v / norm);
}

/**
 * Compute a 512-float ArcFace embedding for one face.
 *
 * @param {string} imageUrl full-size image URL
 * @param {{x,y,w,h}} box    face box as fractions of the image
 * @returns {Promise<number[]|null>} 512 L2-normalised floats, or null if no
 *          face/landmarks are found inside the box (caller skips it).
 */
export async function embedFace(imageUrl, box) {
  const model = await loadArcFace();
  const img = await loadImage(imageUrl);
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;

  // Crop a padded region around the box so landmarks aren't clipped.
  const pad = 0.4;
  const px = Math.max(0, (box.x - box.w * pad) * iw);
  const py = Math.max(0, (box.y - box.h * pad) * ih);
  const pw = Math.min(iw - px, box.w * (1 + pad * 2) * iw);
  const ph = Math.min(ih - py, box.h * (1 + pad * 2) * ih);
  if (pw < 24 || ph < 24) return null;

  const crop = document.createElement("canvas");
  crop.width = Math.round(pw);
  crop.height = Math.round(ph);
  crop.getContext("2d").drawImage(img, px, py, pw, ph, 0, 0, crop.width, crop.height);

  const det = await window.faceapi
    .detectSingleFace(crop, new window.faceapi.SsdMobilenetv1Options({ minConfidence: 0.2 }))
    .withFaceLandmarks();
  if (!det) return null;

  const src = fivePoints(det.landmarks);
  const [a, b, tx, c, d, ty] = umeyama(src, TEMPLATE);

  // Warp the crop into the 112×112 aligned tile.
  const aligned = document.createElement("canvas");
  aligned.width = ALIGN_SIZE;
  aligned.height = ALIGN_SIZE;
  const actx = aligned.getContext("2d");
  actx.setTransform(a, c, b, d, tx, ty);   // canvas order: (a,c,b,d,e,f)
  actx.drawImage(crop, 0, 0);

  // Inference. InsightFace normalises to roughly [-1, 1] as (x-127.5)/128.
  const tfl = tf();
  const embedding = tfl.tidy(() => {
    const input = tfl.browser.fromPixels(aligned)
      .toFloat().sub(127.5).div(128).expandDims(0);
    const out = model.predict(input);
    return Array.from(out.dataSync());
  });
  if (!embedding.length || embedding.length !== 512) return null;
  return l2normalize(embedding);
}
