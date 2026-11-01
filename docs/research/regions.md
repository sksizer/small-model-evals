# Regions suite research: small local detectors and ground truth

Researched 2026-11-01 for a `regions` suite (models return labelled boxes, scored by IoU >= 0.5).
Target: Apple M4, 16 GB, Node 24, `@huggingface/transformers` 4.3.1 (installed version checked in
`node_modules`), or Ollama. Nothing was downloaded except metadata. Licence claims cite the
Hugging Face model API/card (`https://huggingface.co/api/models/<id>` carries the card's `license:`
tag) or the upstream repo. "Unverified" means I could not confirm it.

## Summary

| Job | Start with | Runtime | Size | Licence | Ground truth |
| --- | --- | --- | --- | --- | --- |
| 1 Everyday objects | `onnx-community/dfine_n_coco-ONNX` (also `dfine_s_coco-ONNX`, `rtdetr_r18vd`) | transformers.js `object-detection` | 4.5 MB q8 / 15 MB fp32 | Apache-2.0 (inherited) | COCO 2017 val, CC BY images only (857 of 5000) |
| 2 Named thing | `onnx-community/owlv2-base-patch16-ensemble-ONNX` (q4f16/int8); `grounding-dino-tiny-ONNX` as second | transformers.js `zero-shot-object-detection` | 128-163 MB (OWLv2), 151-204 MB (GDINO) | Apache-2.0 | Open Images V7 val boxes (CC BY 2.0 images), e.g. Whiteboard; receipts from CORD |
| 3 Faces | YuNet (`opencv/face_detection_yunet`) via raw onnxruntime-node | raw ORT | 0.2 MB | MIT | Open Images "Human face" (3,124 val images, 5,594 boxes) |
| 4 Text regions | PP-OCRv5 mobile det (`PaddlePaddle/PP-OCRv5_mobile_det_onnx`) via raw ORT; Florence-2 `<OCR_WITH_REGION>` as the VLM comparison | raw ORT / Florence2 class | 4.8 MB / ~220 MB q4f16 | Apache-2.0 / MIT | CORD v2 (CC BY 4.0) for receipts; TextOCR for scene text |
| 5 Nudity regions | NudeNet v3.4 320n is the only box detector found, and it is **AGPL-3.0** | raw ORT | 12.2 MB | AGPL-3.0 (red flag) | None usable; private hand-annotated set |

Red flags:

- NudeNet (code, and the YOLOv8-based weights) is AGPL-3.0; HF mirrors labelling it Apache-2.0 or MIT contradict upstream.
- Ultralytics YOLO (any YOLOv8/11 family, incl. face fine-tunes) is AGPL-3.0.
- InsightFace/SCRFD weights are non-commercial research only (InsightFace README); the `immich-app` MIT mirror is unverified against that.
- WIDER FACE is `cc by-nc-nd` on its homepage: do not commit its images.
- FUNSD terms: "non-commercial, research purposes only".
- COCO val: only licence id 4 (CC BY, 857 images) is committable. Ids 1,2,3,5,6 are NC/SA/ND. Id 7 (5 images) is "No known copyright restrictions", not a formal PD dedication.
- Qwen2.5-VL 3B is `qwen-research` licence (not Apache); 7B is Apache-2.0.
- FDDB licence: unverified (news-photo origin).

## Runtime notes (transformers.js 4.3.1)

Checked in `node_modules/@huggingface/transformers/src/models/registry.js`: detection classes exist
for `detr`, `rt_detr`, `rt_detr_v2`, `rf_detr`, `d_fine`, `yolos`, `owlvit`, `owlv2`,
`grounding-dino` (`GroundingDinoForObjectDetection`), and `florence2`
(`Florence2ForConditionalGeneration`, with a `Florence2Processor.post_process_generation` that returns
`bboxes` for detection/grounding tasks and `quad_boxes` for OCR). Pipelines present: `object-detection`,
`zero-shot-object-detection`. Grounding DINO through the `zero-shot-object-detection` pipeline is
what the `onnx-community` card advertises (pipeline_tag `zero-shot-object-detection`); I did not run it.
Detection outputs from the pipeline are normalised or pixel boxes depending on `percentage` option; the
provider should request pixel coords and convert.

Models with no transformers.js class (YuNet, SCRFD, BlazeFace, DBNet/PaddleOCR, NudeNet) need
`onnxruntime-node` directly with hand-written pre/post-processing (anchor decode + NMS for faces, DB
binarisation + box unclip for text, YOLOv8 head decode + NMS for NudeNet).

## Job 1: Everyday objects (fixed-class detectors)

| Model (HF id) | Pipeline | Params | ONNX sizes | Licence | Released |
| --- | --- | --- | --- | --- | --- |
| `onnx-community/dfine_n_coco-ONNX` (base `ustc-community/dfine-nano-coco`, 3.8M) | `object-detection` (d_fine) | 3.8M | 15.3 MB fp32, 7.9 fp16, 4.5 q8 | Apache-2.0 via base [ustc-community/dfine-nano-coco](https://huggingface.co/api/models/ustc-community/dfine-nano-coco); ONNX repo has no licence tag | 2025-04-30 (onnx), base 2025-03-28 |
| `onnx-community/dfine_s_coco-ONNX` | `object-detection` | 10.35M (base [dfine-small-coco](https://huggingface.co/api/models/ustc-community/dfine-small-coco)) | 41.5 MB fp32, 21.0 fp16, 11.2 q8 | Apache-2.0 via base | 2025-04-30 |
| `onnx-community/rtdetr_r18vd` (base [PekingU/rtdetr_r18vd](https://huggingface.co/api/models/PekingU/rtdetr_r18vd)) | `object-detection` (rt_detr) | 20.2M | 82.6 MB fp32, 41.4 fp16, 21.7 q8 | Apache-2.0 via base | 2024-06-28 |
| `onnx-community/rtdetr_r50vd` | `object-detection` | 43.0M | 175 MB, 88 fp16, 45.5 q8 | Apache-2.0 via base | 2024-06-28 |
| `onnx-community/rfdetr_base-ONNX` | `object-detection` (rf_detr) | not checked | 107.8 MB, 55 fp16, 29.6 q8 | Apache-2.0 ([card](https://huggingface.co/api/models/onnx-community/rfdetr_base-ONNX)) | 2025-03-29 |
| `Xenova/yolos-tiny` (base [hustvl/yolos-tiny](https://huggingface.co/api/models/hustvl/yolos-tiny)) | `object-detection` (yolos) | 6.5M | 26.2 MB, 13.3 fp16, 9.7 q8 | Apache-2.0 via base | 2023-08-26 |
| `Xenova/detr-resnet-50` (base [facebook/detr-resnet-50](https://huggingface.co/api/models/facebook/detr-resnet-50)) | `object-detection` (detr) | 41.6M | 167 MB, 84 fp16, 43 q8 | Apache-2.0 via base | 2023-05-02 |

Other D-FINE sizes (m, l, x) and `obj365` / `obj2coco` variants exist under `onnx-community/dfine_*-ONNX`.
RT-DETRv2: `PekingU/rtdetr_v2_r18vd` is Apache-2.0 (2025-01-31) but I found no `onnx-community` export
(`onnx-community/rtdetr_v2_r18vd` returns 401/absent); the registry supports `rt_detr_v2`, so a local
`optimum` export would work. All of these are COCO 80-class.

Not recommended: YOLOv8/v11 (Ultralytics, AGPL-3.0; [repo licence](https://github.com/ultralytics/ultralytics)).

## Job 2: Find a named thing (open vocabulary)

| Model | Pipeline | Params | ONNX sizes | Licence | Released |
| --- | --- | --- | --- | --- | --- |
| `onnx-community/owlv2-base-patch16-ensemble-ONNX` (also `Xenova/owlv2-base-patch16-ensemble`) | `zero-shot-object-detection` | 155M ([google/owlv2-base-patch16-ensemble](https://huggingface.co/api/models/google/owlv2-base-patch16-ensemble)) | 614 MB fp32, 307 fp16, 163 q8/int8, 128 q4f16 | Apache-2.0 via base | onnx 2025-07-30; base 2023-10-13 |
| `Xenova/owlvit-base-patch32` | `zero-shot-object-detection` | 153M ([google/owlvit-base-patch32](https://huggingface.co/api/models/google/owlvit-base-patch32)) | 612 MB, 307 fp16, 155 q8, 127 q4f16 | Apache-2.0 via base | 2023-11-13 |
| `onnx-community/grounding-dino-tiny-ONNX` | `zero-shot-object-detection` (grounding-dino) | 172M ([IDEA-Research/grounding-dino-tiny](https://huggingface.co/api/models/IDEA-Research/grounding-dino-tiny)) | 719 MB, 360 fp16, 204 q8, 151 q4f16 | Apache-2.0 ([card](https://huggingface.co/api/models/onnx-community/grounding-dino-tiny-ONNX)) | 2025-01-05 |
| `onnx-community/Florence-2-base` (and `-base-ft`), task `<CAPTION_TO_PHRASE_GROUNDING>` | `Florence2ForConditionalGeneration` + processor | 231M ([microsoft/Florence-2-base](https://huggingface.co/api/models/microsoft/Florence-2-base)) | per-part; q4f16 parts sum ~220 MB (vision 62.5, encoder 25.7, decoder merged 56.5, embed 78.8); int8 ~275 MB | MIT ([card](https://huggingface.co/api/models/onnx-community/Florence-2-base)) | 2024-06-21 |
| `onnx-community/Florence-2-large` | same | 777M | q4f16 ~480 MB (vision 243, enc 88, dec 147, embed 105); fp32 >3 GB | MIT | 2024-06-22 |

Notes: OWL-ViT/OWLv2 take a text query list and return scored boxes; OWLv2 at 960 px input is heavy on
CPU (expect seconds per image); the q8/q4f16 files are the memory-friendly choice. Florence-2 phrase
grounding returns boxes in pixel coords of the image, text query is the phrase. `<OD>` gives a fixed
label vocabulary from generated text; `<OCR_WITH_REGION>` returns quad boxes with text.
Florence-2 large in ONNX is likely too big for the "memory matters" goal.

## Job 3: Faces

| Model | Runtime | Params / size | Licence | Released |
| --- | --- | --- | --- | --- |
| YuNet 2023mar, `opencv/face_detection_yunet` (`face_detection_yunet_2023mar.onnx` 0.2 MB, int8 0.1 MB) | raw onnxruntime-node (fixed-shape model; OpenCV infers on exact shape, [README](https://huggingface.co/opencv/face_detection_yunet/raw/main/README.md)); WIDER val AP easy/med/hard 0.884/0.866/0.750 | ~75k params (unverified), 0.2 MB | MIT: [opencv_zoo README](https://raw.githubusercontent.com/opencv/opencv_zoo/main/models/face_detection_yunet/README.md) "licensed under MIT", LICENSE (c) Shiqi Yu; HF repo has no licence tag | 2023-03 (HF repo 2025-06-06) |
| SCRFD (`RuteNL/SCRFD-face-detection-ONNX`: 500m 2.3 MB, 1g 2.5, 2.5g_bnkps 3.3, 10g 16.9, 34g 39) | raw ORT (anchor decode + NMS) | 0.5-34 GFLOPs variants | Mirror says Apache-2.0; InsightFace states models are "available for non-commercial research purposes only" ([README](https://raw.githubusercontent.com/deepinsight/insightface/master/README.md), [model_zoo](https://raw.githubusercontent.com/deepinsight/insightface/master/model_zoo/README.md)). `immich-app/scrfd_34g_gnkps` (39.4 MB) says MIT and traces to ModelScope ([card](https://huggingface.co/immich-app/scrfd_34g_gnkps/raw/main/README.md)); provenance **unverified** | mirror 2026-03-07; immich 2024-08-12 |
| BlazeFace (MediaPipe), e.g. `garavv/blazeface-onnx`, `software-mansion/BlazeFace-ExecuTorch` | raw ORT | ~0.1M params, <1 MB (unverified) | MediaPipe is Apache-2.0 ([repo](https://github.com/google-ai-edge/mediapipe)); ONNX mirrors untagged; short-range model sees faces only up to ~2 m. Unverified conversions | mirrors 2025-2026 |
| RetinaFace (e.g. `amd/retinaface`, Apache-2.0) | raw ORT | ~1.7M (mobilenet) to 27M | Apache-2.0 tag on mirror; upstream weights provenance unverified | 2023-12-05 |
| `opencv/face_detection_yunet` int8 | raw ORT | 0.1 MB | MIT | |

Also usable as a face baseline through transformers.js: none of the COCO detectors have a face class.
Prefer YuNet: tiny, MIT, simplest decode (output is 12-dim per anchor: bbox, 5 landmarks, score; 3 strides).
Note YuNet's own doc says faces ~10-300 px; large close-up faces can be missed, relevant to the dataset choice.

## Job 4: Text regions (documents, screenshots)

| Model | Runtime | Size | Licence | Released |
| --- | --- | --- | --- | --- |
| `PaddlePaddle/PP-OCRv5_mobile_det_onnx` (DBNet-style, `inference.onnx` 4.83 MB) | raw ORT; DB post-process (threshold, contours, unclip) | 4.8 MB | Apache-2.0 ([card](https://huggingface.co/api/models/PaddlePaddle/PP-OCRv5_mobile_det_onnx); PaddleOCR repo [Apache-2.0](https://github.com/PaddlePaddle/PaddleOCR)) | 2026-05-26 |
| `PaddlePaddle/PP-OCRv6_tiny_det_onnx` (1.78 MB) / `PP-OCRv6_small_det_onnx` (9.9 MB) | raw ORT | 1.8 / 9.9 MB | Apache-2.0 ([card](https://huggingface.co/api/models/PaddlePaddle/PP-OCRv6_tiny_det_onnx)) | 2026-06-09 |
| `SWHL/RapidOCR` `PP-OCRv4/ch_PP-OCRv4_det_infer.onnx` (4.7 MB; server 113 MB) | raw ORT | 4.7 MB | Apache-2.0 ([card](https://huggingface.co/api/models/SWHL/RapidOCR); [RapidOCR](https://github.com/RapidAI/RapidOCR) Apache-2.0) | repo 2024-04-13 |
| `deepghs/text_detection` (mmocr DBNet r18/r50 ICDAR2015, 48-107 MB `end2end.onnx`) | raw ORT | 48.7 MB (r18) | MIT tag ([card](https://huggingface.co/api/models/deepghs/text_detection)); mmocr is Apache-2.0; trained on ICDAR2015 whose own terms are unverified | 2023-10-08 |
| `onnx-community/Florence-2-base`, task `<OCR_WITH_REGION>` | Florence2 class | ~220 MB q4f16 | MIT | 2024-06-21 |
| Avoid: `StabRise/text_detection_dbnet_ml_v0.2` (4.8 MB) is **AGPL-3.0** ([card](https://huggingface.co/api/models/StabRise/text_detection_dbnet_ml_v0.2)) | | | | |

Detectors return quadrilaterals; the scorer should take the axis-aligned bounding rect, and the GT
granularity (word vs line) must match (PP-OCR returns line-level, CORD is word-level, so merge or
score with a looser matching rule). Also noted: `onnx-community/Surya-Ocr-2-Onnx` exists but has no licence tag (Surya's own weights licence is restrictive, unverified here).

## Job 5: Nudity regions

| Model | Runtime | Size | Licence | Released |
| --- | --- | --- | --- | --- |
| NudeNet v3.4 `320n.onnx` (YOLOv8n) | raw ORT, YOLOv8 head decode + NMS, 320 px | 12.2 MB; ONNX direct from [release v3.4-weights](https://github.com/notAI-tech/NudeNet/releases/tag/v3.4-weights) (also on HF `deepghs/nudenet_onnx`, `vladmandic/nudenet`) | **AGPL-3.0** ([repo licence](https://github.com/notAI-tech/NudeNet/blob/v3/LICENSE); README says models are "based on ultralytics yolov8"). HF mirrors claim Apache-2.0 (`deepghs/nudenet_onnx`) or MIT (`zhangsongbo365/nudenet_onnx`), which conflicts with upstream: treat as AGPL | 2024-06-30 |
| NudeNet v3.4 `640m.onnx` (YOLOv8m) | same, 640 px | 103.5 MB | AGPL-3.0 | 2024-06-30 |

Label set (18): FEMALE_GENITALIA_COVERED, FACE_FEMALE, BUTTOCKS_EXPOSED, FEMALE_BREAST_EXPOSED,
FEMALE_GENITALIA_EXPOSED, MALE_BREAST_EXPOSED, ANUS_EXPOSED, FEET_EXPOSED, BELLY_COVERED, FEET_COVERED,
ARMPITS_COVERED, ARMPITS_EXPOSED, FACE_MALE, BELLY_EXPOSED, MALE_GENITALIA_EXPOSED, ANUS_COVERED,
FEMALE_BREAST_COVERED, BUTTOCKS_COVERED ([README](https://raw.githubusercontent.com/notAI-tech/NudeNet/v3/README.md)).
Output box format is `[x, y, w, h]` in pixels of the original image.

Eval-only use of an AGPL model in a private harness is less of a problem than shipping it, but the
repo should not vendor the weights or code and should not recommend shipping it in a product. No
permissive box-level nudity detector was found; Falconsai/Marqo/viddexa NSFW models are Apache-2.0 but
whole-image classifiers (no regions). Comparison options: Florence-2 `<CAPTION_TO_PHRASE_GROUNDING>`
and OWLv2 with queries like "exposed breast" (expected weak and unsafe-by-default), and Qwen3-VL grounding.

## Ollama vision LLMs that output boxes (for comparison)

| Model | Ollama sizes | Box format | Licence |
| --- | --- | --- | --- |
| `qwen3-vl` ([library](https://ollama.com/library/qwen3-vl)) | 2B 1.9 GB, 4B 3.3, 8B 6.2, 30B 20, 32B 21, 235B | Relative coordinates 0 to 1000 (Qwen3-VL cookbook: "changed from the absolute coordinates used in Qwen2.5-VL to relative coordinates ranging from 0 to 1000", [source](https://raw.githubusercontent.com/QwenLM/Qwen3-VL/main/cookbooks/2d_grounding.ipynb)); prompt asks for JSON `bbox_2d` | Apache-2.0 for 2B ([card](https://huggingface.co/api/models/Qwen/Qwen3-VL-2B-Instruct)); other sizes unverified |
| `qwen3.5` ([library](https://ollama.com/library/qwen3.5)) | 0.8B 1.2 GB, 2B 2.7, 4B 3.3, 9B 6.6, 27B 17 | Grounding format **unverified**: the Ollama page and 4B card do not mention boxes; its benchmark tables include RefCOCO. Probe it before scoring (likely 0-1000 like Qwen3-VL) | Apache-2.0 (2B and 4B [cards](https://huggingface.co/api/models/Qwen/Qwen3.5-4B)); released Feb 2026 |
| `qwen2.5vl` | 3B, 7B, 32B, 72B | Absolute pixel coordinates of the (resized) input image, JSON `bbox_2d` [x1,y1,x2,y2]; the resized size depends on min/max pixels, so mapping back to the original needs care | 3B: `qwen-research` ([card](https://huggingface.co/Qwen/Qwen2.5-VL-3B-Instruct/raw/main/README.md)); 7B Apache-2.0 |

These are 2-10 GB and slow compared with the 5-200 MB detectors above; useful as the "general model" arm.

## Ground-truth datasets

| Dataset | Annotation licence | Image licence | Committable? | Notes |
| --- | --- | --- | --- | --- |
| COCO 2017 val | CC BY 4.0 (COCO terms page; text not retrievable here, claim from the standard COCO terms, **unverified on page**) | Per-image Flickr licence in `instances_val2017.json` | Only licence id 4 (857 images) and 7 (5 images) | See below |
| Open Images V7 | CC BY 4.0 ([facts page](https://storage.googleapis.com/openimages/web/factsfigures_v7.html)) | "listed as CC BY 2.0"; Google gives no warranty. Verified: all 41,620 rows of the validation image CSV are `https://creativecommons.org/licenses/by/2.0/` | Yes with attribution (author + landing URL are in the CSV) | Faces, Whiteboard, objects |
| WIDER FACE | Homepage lists "Creative Common License (cc by-nc-nd)" ([page](http://shuoyang1213.me/WIDERFACE/), certificate broken for https) | Same notice; per-image Flickr-like sources not cleared | **No** (NC, ND) | Use for local-only scoring at most |
| FDDB | unverified | Yahoo news photos, unverified | No (unverified) | 2,845 images, 5,171 ellipse faces; ellipses need conversion ([paper](https://people.cs.umass.edu/~elm/papers/fddb.pdf)) |
| TextOCR | CC BY 4.0 (per MMOCR metafile/HF card, via search; not fetched from the official page) | Images are Open Images (CC BY 2.0 by the above check) | Yes with attribution, only for images present in OI | 28k images, word-level polygons |
| FUNSD | "non-commercial, research purposes only" ([terms](https://guillaumejaume.github.io/FUNSD/work/)) | Scanned business forms (source rights unverified) | **No** | 199 forms, word boxes |
| DocLayNet | CDLA-Permissive-1.0 ([LICENSE](https://raw.githubusercontent.com/DS4SD/DocLayNet/main/LICENSE)) | Pages rendered from public PDFs (financial reports, patents, manuals...) whose individual copyright is **not cleared** | Annotations yes, images doubtful | 80,863 pages, 11 layout classes, not text lines; 28 GiB core zip (do not download) |
| CORD v2 | CC BY 4.0 ([HF card](https://huggingface.co/api/datasets/naver-clova-ix/cord-v2) `license: cc-by-4.0`; GitHub clovaai/cord README is CC BY 4.0) | Same card covers the receipt images | Yes with attribution (check the card on redistribution of derived images) | ~1000 receipts, word quads in `ground_truth` JSON; real "receipt" images for job 2 |
| ICDAR (2015 RRC, etc.) | unverified (site requires registration/terms) | unverified | No | Skip |
| Nudity regions | none usable | n/a | n/a | No public box dataset with a compatible licence; NudeNet's training data is not released as a dataset (upstream auto-generated set is in release v0 `DETECTOR_AUTO_GENERATED_DATA.zip` 660 MB, licence and content unreviewed, do not use) |

### COCO 2017 val licence ids (verified)

I read `annotations/instances_val2017.json` inside the official zip
(`http://images.cocodataset.org/annotations/annotations_trainval2017.zip`) via HTTP range requests (only
the one member, no full download). `licenses` array:

| id | Licence | val images |
| --- | --- | --- |
| 1 | CC BY-NC-SA 2.0 | 1431 |
| 2 | CC BY-NC 2.0 | 630 |
| 3 | CC BY-NC-ND 2.0 | 1414 |
| 4 | **CC BY 2.0** | **857** |
| 5 | CC BY-SA 2.0 | 417 |
| 6 | CC BY-ND 2.0 | 246 |
| 7 | "No known copyright restrictions" (Flickr Commons) | **5** |
| 8 | US Government Work | 0 |

Filter: keep `images[].license in {4, 7}`, then use `coco_url`/`flickr_url` for the file and
`flickr_url` for attribution. CC BY is OK under your rule (attribution needed); id 6 (ND) and 5 (SA) are out.
Id 7 is not a CC0 dedication, but is effectively public-domain-like; confirm per image on Flickr before committing.
COCO has no face class; "person" boxes only. Note the COCO annotation licence itself was not retrievable from the
terms page (the fetch returned only navigation), so "CC BY 4.0" is unverified from the page.

### Open Images: how to filter

- Image licence + attribution (validation): `https://storage.googleapis.com/openimages/2018_04/validation/validation-images-with-rotation.csv` (15 MB; columns ImageID, OriginalURL, OriginalLandingURL, License, AuthorProfileURL, Author, Title, Thumbnail300KURL). Every row is CC BY 2.0 (checked). Test set equivalent: `.../2018_04/test/test-images-with-rotation.csv`.
- Boxes: `https://storage.googleapis.com/openimages/v5/validation-annotations-bbox.csv` (25 MB; the V7 filename 403s, V5 validation boxes are the same set the download page links). Columns include ImageID, LabelName, XMin/XMax/YMin/YMax (normalised), IsGroup, IsOccluded.
- Classes: `https://storage.googleapis.com/openimages/v7/oidv7-class-descriptions-boxable.csv`. Verified in the boxable list: Human face `/m/0dzct`, Whiteboard `/m/02d9qx`, Human head `/m/04hgtk`, Person `/m/01g317`, Laptop, Poster, Billboard, Mobile phone, Book, Computer monitor, Traffic sign, Swimwear, Clothing. There is **no "Receipt"** class.
- Counts in the validation bbox file (measured): Human face 5,594 boxes in 3,124 images; Human head 8,765 in 3,711; Whiteboard only 20 boxes in 20 images; Person 16,753 in 7,144.
- Use `IsGroup=0`, drop `IsOccluded`/tiny boxes. Image download: `OriginalURL` (Flickr) with `Thumbnail300KURL` as a fallback; some links rot. Note Open Images face boxes are not exhaustive (crowd faces may be unlabeled), which penalises precision; score recall-heavy or use images with few faces.
- Attribution: Author + OriginalLandingURL from the CSV go in the corpus metadata.

## Recommendations

1. **Everyday objects**: D-FINE nano then small (`dfine_n_coco-ONNX` q8 4.5 MB, `dfine_s_coco-ONNX` q8 11 MB), with `rtdetr_r18vd` q8 (21.7 MB) as the RT-DETR comparison. All transformers.js `object-detection`, Apache-2.0. Ground truth: ~50 COCO val images with licence id 4 (annotations CC BY 4.0, unverified page) plus Open Images V7 val boxes (both CC BY). Match on class names; Open Images uses different class names than COCO, so map to the 80 COCO labels or restrict to shared ones (Person, Dog, Cat, Car, Laptop...).
2. **Named thing**: OWLv2 base ensemble (int8 163 MB or q4f16 128 MB) and Grounding DINO tiny (q4f16 151 MB); Florence-2 base phrase grounding (~220 MB) as the third arm. Ground truth: Open Images val Whiteboard (20 images, CC BY) and other boxable classes queried by name (Poster, Laptop...); receipts need self-annotation, e.g. CORD (CC BY 4.0) with whole-receipt boxes drawn by hand.
3. **Faces**: YuNet 2023mar (0.2 MB, MIT, raw ORT) first; SCRFD 500m/2.5g only after confirming the weights licence (non-commercial per InsightFace), so use only locally if at all. Ground truth: Open Images "Human face" (CC BY 2.0 images, CC BY 4.0 boxes), choose images with 1-4 labelled faces. Avoid WIDER FACE images in the repo (CC BY-NC-ND).
4. **Text regions**: PP-OCRv5 mobile det (4.8 MB, Apache-2.0, raw ORT) first, Florence-2 base `<OCR_WITH_REGION>` as the VLM arm. Ground truth: CORD v2 receipts (CC BY 4.0, word quads, merge to lines) for documents; TextOCR (CC BY 4.0, Open Images photos) for scene text; screenshots need self-annotation or synthetic pages (the repo already renders synthetic pages with Chrome, so boxes can be emitted from the DOM at render time, which makes exact ground truth).
5. **Nudity regions**: only NudeNet 320n (AGPL-3.0, 12.2 MB) exists as a detector; run it as a local eval reference if acceptable but flag it. No public box dataset: positives stay in the private copy (as `nudity-flag` already does) with hand-drawn boxes, and public negatives (no boxes expected) give a false-positive-rate score. Compare a VLM grounding arm (Qwen3-VL 2B/4B) since it needs no AGPL code.

Open items I could not confirm: COCO annotation licence text on the terms page; FDDB, ICDAR, SCRFD
mirrors licences; param counts for YuNet/BlazeFace/RF-DETR; transformers.js runtime behaviour of
Grounding DINO and D-FINE (class exists in the registry, not executed); Qwen3.5 box format; per-image
rights of CORD and DocLayNet source documents.
