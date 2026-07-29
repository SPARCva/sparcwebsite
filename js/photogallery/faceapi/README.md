# Vendored face-api.js

In-browser face detection and recognition for `/photogallery/admin/`
(People & Faces). Served from our own origin rather than a CDN, so the admin
tool keeps working at an event on bad wifi, and so no third-party request is
made while handling constituents' photos.

## Contents

| File | Size | What |
| --- | --- | --- |
| `face-api.min.js` | ~1.3 MB | The library bundle |
| `model/tiny_face_detector_model-*` | ~196 KB | Face detection |
| `model/face_landmark_68_model-*` | ~365 KB | Landmarks (needed for alignment) |
| `model/face_recognition_model-*` | ~6.4 MB | 128-float descriptors |

Total ~8 MB. Loaded lazily — `js/photogallery/faces.js` injects the script and
calls `loadFromUri` only when someone opens the People & Faces tab, so a normal
admin page load fetches none of it.

## Source and updating

Upstream: [`@vladmandic/face-api`](https://github.com/vladmandic/face-api), a
maintained fork of the original `face-api.js`. Files were taken verbatim from
the jsDelivr copy of the npm package:

```sh
BASE=https://cdn.jsdelivr.net/npm/@vladmandic/face-api
cd js/photogallery/faceapi
curl -sSLo face-api.min.js "$BASE/dist/face-api.min.js"
for net in tiny_face_detector face_landmark_68 face_recognition; do
  curl -sSLo "model/${net}_model-weights_manifest.json" "$BASE/model/${net}_model-weights_manifest.json"
  curl -sSLo "model/${net}_model.bin"                   "$BASE/model/${net}_model.bin"
done
```

The manifests reference their `.bin` shards by relative filename, so the two
must be updated together and must keep these names.

Only these three nets are vendored. If a future feature needs another
(`ageGenderNet`, `faceExpressionNet`, `ssdMobilenetv1`, …), add its manifest and
`.bin` here and load it in `faces.js` — do not point at the CDN for one net.

## Licence

face-api.js is MIT-licensed, as is the TensorFlow.js code it bundles. The model
weights are redistributable under the same terms. Keep this note with the files.

## Note on Google Identity Services

The other third-party script the admin loads — `accounts.google.com/gsi/client`,
for the Google Photos picker — **cannot** be vendored. Google requires it to be
loaded from `accounts.google.com`: it is versioned server-side and the OAuth
flow depends on being served from Google's own origin. Self-hosting a copy is
unsupported and would break sign-in. It is loaded lazily, only when someone
actually clicks "Add from Google Photos", so it costs nothing on a normal page
load and a Google outage only affects that one button.
