# ArcFace model (Tier 3 high-accuracy recognizer)

This folder holds the **vendored TensorFlow.js ArcFace model** used by the
opt-in high-accuracy recognizer (`js/photogallery/faces-arcface.js`). It is
served from our own origin — like the face-api bundle one level up — so face
tagging keeps working at an event on unreliable wifi and **no third-party
request is made while handling constituents' photos**.

## What must be here

```
arcface/
  model.json          TFJS graph-model manifest
  group1-shard1of*.bin weight shards referenced by model.json
```

`faces-arcface.js` loads `./model.json` via `tf.loadGraphModel`. Until these
files are present, the recognizer's **Compute ArcFace embeddings** button in
Settings shows a "model not vendored yet" error and the rest of the admin is
unaffected (the default face-api recognizer keeps working).

## Getting the weights

The model is an **ArcFace / InsightFace** face-embedding network exported to the
TFJS graph-model format. It must:

- take a **112×112×3** RGB face tile, normalised `(pixel − 127.5) / 128`, and
- output a **512-float** embedding.

`vladmandic/insightface` (the TFJS InsightFace port,
<https://github.com/vladmandic/insightface>) publishes a compatible model. Fetch
its model directory and place `model.json` + the `.bin` shards here unchanged.
If you export your own ArcFace ONNX → TFJS instead, keep the same input size,
normalisation and output length, or update the constants in `faces-arcface.js`
(`ALIGN_SIZE`, the normalisation in `embedFace`) and the cosine thresholds
(`RECOGNIZER_BANDS.arcface` in the edge function, and the migration's RPC
defaults) to match.

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
