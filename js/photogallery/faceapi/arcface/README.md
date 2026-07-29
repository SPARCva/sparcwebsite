# ArcFace model (Tier 3 high-accuracy recognizer)

This folder holds the **vendored TensorFlow.js ArcFace model** used by the
opt-in high-accuracy recognizer (`js/photogallery/faces-arcface.js`). It is
served from our own origin — like the face-api bundle one level up — so face
tagging keeps working at an event on unreliable wifi and **no third-party
request is made while handling constituents' photos**.

## What is vendored here

```
arcface/
  model.json                        TFJS graph-model manifest
  insightface-efficientnet-b0.bin   weight file referenced by model.json (~13 MB)
```

`faces-arcface.js` loads `./model.json` via `tf.loadGraphModel`. Until these
files are present, the recognizer's **Compute ArcFace embeddings** button in
Settings shows a "model not vendored yet" error and the rest of the admin is
unaffected (the default face-api recognizer keeps working).

**Model:** `insightface-efficientnet-b0` from the
[`vladmandic/insightface`](https://github.com/vladmandic/insightface) TFJS
InsightFace port — an ArcFace-trained EfficientNet-B0 embedder. Fetched from
the pinned CDN mirror of that repo's `master`:

```
https://cdn.jsdelivr.net/gh/vladmandic/insightface@master/models/insightface-efficientnet-b0.json  → model.json
https://cdn.jsdelivr.net/gh/vladmandic/insightface@master/models/insightface-efficientnet-b0.bin   → (unchanged)
```

It matches what `faces-arcface.js` expects:

- **input** `input_1` shape `[-1, 112, 112, 3]`, RGB, normalised `(pixel − 127.5) / 128`;
- **output** `embedding` shape `[-1, 512]`.

It was chosen over the other ports in that repo because it is the most accurate
of the 512-float variants (efficientnet-b0 / ghostnet / mobilenet-swish) while
still small enough to serve from our own origin; `mobilenet-emore` was rejected
because it emits **256** floats, not 512.

**Load verified headlessly:** the file above was loaded through the site's own
bundled face-api TensorFlow.js (`window.faceapi.tf.loadGraphModel`) in headless
Chromium and produced a `1×512` output tensor — confirming op-compatibility with
the exact TFJS the browser uses. Embedding *quality* still needs the in-browser
validation below, since a dummy tile can't exercise recognition accuracy.

## Replacing the weights

If you export your own ArcFace ONNX → TFJS instead, keep the same input size,
normalisation and output length, or update the constants in `faces-arcface.js`
(`ALIGN_SIZE`, the normalisation in `embedFace`) and the cosine thresholds
(`RECOGNIZER_BANDS.arcface` in the edge function, and the migration's RPC
defaults) to match. Name the manifest `model.json` and make its
`weightsManifest[].paths` point at whatever `.bin` file(s) you place here.

## Do not commit huge weights without checking repo policy

The weights are several tens of MB. Confirm they belong in git (as the face-api
weights are) rather than object storage before committing, and keep this README
in sync with whatever is actually vendored.

## After vendoring — validate before relying on it

1. In Settings → **High-accuracy recognizer (beta)**, run **Compute ArcFace
   embeddings** on a **test album**.
2. Confirm a few faces and check the suggestion quality in **Confirm names**.
3. Tune `RECOGNIZER_BANDS.arcface` (edge function) and the `*_v2` RPC default
   `p_max_distance` (migration) against what you see — cosine distance is a
   different scale from face-api's euclidean, so the starting numbers are only
   a guess.
4. Only then **Switch matching to ArcFace** for real use.
