# Prototype 15 — Tap-to-Segment (SAM-family) for Add-Item Flow

Planning doc. Drives notebook `15_tap_to_segment.ipynb` + a small HTML interaction prototype. Lives in `prototypes/notebooks/` (gitignored research zone).

Cross-refs:
- `notes/ai-generated/segmentation-3d-video-research.md` §1 — model landscape, licence table, server-cleanup pass.
- `notes/ai-generated/add-item-flow-bbox-revamp.md` — card-driven UX this segmentation slots into.
- `src/transport/web/app/src/components/DetectionOverlay.tsx` — the component tap-to-segment eventually replaces the rectangle-drag behaviour inside.
- `src/transport/web/app/src/modals/AddItemFlow.tsx` — the flow that hosts DetectionOverlay.

## 1. Goal

Replace "drag a rectangle around each garment" with **tap-on-garment → mask returned → tight bbox derived from mask → cropped photo + original photo handed to Gemini** for hero-image/categorize.

Two concrete deliverables out of this prototype:

1. **Model decision.** MobileSAM vs EdgeSAM vs SAM 2 (tiny) for the in-browser interactive pass. Picked on real wardrobe photos, not on COCO benchmarks.
2. **Interaction confirmation.** Can a tap-on-phone return a useful mask in under ~500 ms? Does the card-driven UX from `add-item-flow-bbox-revamp.md` *feel* right when masks land instantly instead of via a drag?

Out of scope here: the server-side SAM-HQ cleanup pass (deferred to a follow-up — fine to validate later). Out of scope: anything that touches `src/` — this is staging-area work only.

## 2. What we're working with

### 2.1 Today's flow (`AddItemFlow.tsx` + `DetectionOverlay.tsx`)

1. User uploads photo(s) → `detecting` step calls `POST /api/items/bulk-detect` (Gemini 2.5 spatial).
2. Gemini returns `Detection[]` with `box: { x, y, w, h }` in % of container.
3. `bbox` step renders `DetectionOverlay` — user drags/resizes rectangles, taps badges to re-categorise, taps photo to add a new box.
4. On "next" → each `kept` detection becomes a `ReviewItem`; `cropToBbox(file, box)` crops in-browser; the crop goes to `analyzeItem()` (Gemini categorize) and to `createItem()`.

Today the *input to Gemini* is a rectangular crop from the original photo. Nothing else.

### 2.2 What changes with tap-to-segment

- Tap on a garment → MobileSAM returns a binary mask.
- Tight bbox derived from mask extents (replaces dragged rectangle).
- Mask itself is *additive metadata* — saved alongside the crop, used later for:
  - sticker treatments in `OutfitDetail` / home page.
  - server-side SAM-HQ cleanup pass during save (future).
- **The crop sent to Gemini stays as raw rectangular pixels.** Per `feedback_rembg_not_for_hero_gen.md` — Gemini handles backgrounds well; we use the mask for bbox tightening + future stickers, not for stripping pixels before Gemini sees them. This is the load-bearing constraint that keeps us inside the existing rule.
- Hero-image-gen variant: `cropped photo + original photo` both fed to Gemini as context, so it knows the in-context appearance plus the isolated garment. New, but additive — doesn't change existing pipeline.

### 2.3 Where it slots into the bbox-revamp UX

`add-item-flow-bbox-revamp.md` already inverts the interaction model: cards become the control surface, the photo is mostly display. Tap-to-segment is the natural input event for that revamp:

- Tap a garment on the photo → mask arrives → carousel gets a new card showing the live crop (the bg-image trick described in §3.1 of the revamp doc Just Works because we have a real bbox).
- The "drag to author a rectangle" affordance can be hidden behind a long-press fallback for when SAM misses (rare-edge garments, monochrome backgrounds where mask leaks).
- Active-card → highlights mask outline on the photo; resize handles are gone because the mask defines the bbox.

So this prototype validates whether tap-to-segment can carry the bbox-revamp's interaction model without falling back to rectangle authoring.

## 3. Plan — two artefacts

### 3.1 `15_tap_to_segment.ipynb` — model bake-off

Python notebook on the existing prototypes harness (`prototypes/lib/` already has `client.py`, `images.py`, `remove_background.py`).

Cells:

1. **Load test images** — `inputs/20260524_174630.jpg`, `inputs/20260524_174709.jpg`, the `inputs/worn/*.jpg` set. Resize for display, keep originals for mask extraction.
2. **Install models** — `transformers` Python: MobileSAM (`dhkim2810/MobileSAM`), SAM 2 tiny (`facebook/sam2-hiera-tiny`), optionally EdgeSAM if the HF port is up to date. Pin model IDs so reruns are deterministic.
3. **Tap simulation** — for each photo, pick 3–5 tap points by hand in a coords list (or via `matplotlib` `ginput` for interactive). For each (image, tap, model), run prompt-with-point inference → save mask PNG to `outputs/15_masks/<photo>_<model>_<tapIdx>.png`.
4. **Mask → tight bbox** — `np.where(mask) → ymin/xmin/ymax/xmax → padded bbox`. Save crops for each (model, photo, tap) side by side.
5. **Quality grid** — composite plot: rows = tap points, cols = models. Each cell shows the mask overlay + the derived crop. Eyeball for: leakage, missed straps/hems, double-tap behaviour on overlapping garments.
6. **Latency table** — wall-clock per inference on CPU + on Apple Silicon MPS (if local). Not phone-WASM, but a useful proxy for relative cost. Print as markdown table.
7. **Decision cell** — single MD cell at the bottom where the chosen model + reasoning lives. This is what gets promoted into the spec.

Cost: $0 (all local). One-day effort.

### 3.2 `prototypes/web/tap-to-segment/index.html` — interaction feel

Single standalone HTML page. No Vite, no bundler — `<script type="module">` from CDN.

Stack:
- `@huggingface/transformers` (transformers.js v3) from `cdn.jsdelivr.net`.
- The model decided in §3.1 (MobileSAM by default).
- Plain `<canvas>` for the photo + mask overlay; one `<img>` element; vanilla JS.

Behaviour:
- Photo loads (drag-drop or fixed test photo).
- Tap on photo → record (x, y) → run SAM with point prompt → render mask as a `globalCompositeOperation` overlay on the canvas → draw derived bbox.
- Tap again → adds a *second* mask (different colour) — proves multi-item tapping works.
- Below the canvas: a horizontal strip of cards (matches the bbox-revamp spec §3.1) — each card uses the bg-image trick to show the live crop. This is the actual interaction we want to validate.
- A button "FAKE-SEND-TO-GEMINI" that opens a side panel showing the two images we'd send (cropped + original) — no actual API call, just the framing.

Targets:
- iPhone Safari (PWA's real audience).
- Tap → mask < 500 ms on iPhone 14-class. < 1 s acceptable.

Cost: $0. Two-hour effort to scaffold.

## 4. Model picks to compare

From the research doc §1, the candidates are MobileSAM and EdgeSAM (both Apache 2.0, both ONNX-portable). SAM 2 tiny is the quality ceiling we measure against — if MobileSAM is within 10–15 % of SAM 2 on clothing edges, ship MobileSAM. SAM-HQ is the server cleanup option and not in scope for this prototype.

Skip in this prototype:
- **FastSAM** — AGPL-3.0, blocked for our SaaS.
- **Apple VNGenerate...** — native iOS only, not callable from PWA.
- **rembg / BiRefNet** — not promptable (no tap), produces foreground masks not per-item. Already validated in prior notebook 03/04.

## 5. Test image set

Use what's already in `prototypes/inputs/`:
- `20260524_174630.jpg`, `20260524_174709.jpg` — messy-room photos with overlapping garments (the canonical bulk-add test set).
- `worn/*.jpg` — single-item product shots, mostly clean backgrounds.
- Add 2–3 *adversarial* photos before the bake-off:
  - Layered outfit (jacket over shirt) — tests overlapping-garment disambiguation.
  - Thin straps / lace — tests mask edge fidelity.
  - Same-colour-on-same-colour (e.g. white shirt on white duvet) — tests mask leakage.

Acceptable bar: tap on the canonical bulk-add photos returns a *visibly correct* mask 8 / 10 times across MobileSAM. Adversarial set is for understanding failure modes, not pass/fail.

## 6. Integration shape (after prototypes validate)

Sketch only — locks in once we know quality + latency are real.

- `feature/tap-to-segment` branch (small, contained).
- New module: `src/transport/web/app/src/lib/segment/mobileSam.ts` — loads the ONNX model once via `transformers.js`, exposes `segment(image, point: {x,y}): Promise<Mask>`. Worker-isolated so the main thread stays responsive.
- New util: `src/transport/web/app/src/lib/maskToBbox.ts` — pure function, mask → padded tight bbox. Unit-testable.
- `DetectionOverlay.tsx` modified — `onTapAdd` calls `segment()` first, then drops a box at the mask's bbox instead of an empty 20×20 rect at the tap point. The drag/resize handles stay as a *fallback* for SAM misses, until we're confident enough to remove them.
- Mask itself stored client-side only during the flow. Not persisted in v1 (we just use it for bbox derivation). Persisting + server-side SAM-HQ cleanup is a follow-up.
- No backend route changes for v1. Server-side cleanup pass (SAM-HQ → mask.png in user's storage prefix) is a separate branch.

## 7. Multi-user / billing implications

- **Multi-user (Step 14 phase B):** none direct in v1 — masks stay client-side, no per-user data written.
- **Billing (Step 14 phase C `runInstrumented`):** SAM in-browser is **$0 per call**, so it's "free, rate-limited" (no token deduction). Same tier as categorize / scan-tag. The server-side SAM-HQ cleanup (future) is also $0 if self-hosted on the shared GPU at ~$0.0003/call — keep free unless volume forces a re-tier.
- **Storage prefix:** when we eventually persist masks (future), they live under `users/<userId>/items/<itemId>/<viewId>.mask.png`. Inherits the Step 14 storage layout, slots into `saveReferenceImage` (the new lower-compression variant from Step 13 spec).

## 8. Open decisions

- **Model:** MobileSAM vs EdgeSAM after the bake-off. Default to MobileSAM unless EdgeSAM is clearly faster *and* not noticeably worse on the adversarial set.
- **Mask persistence:** v1 client-only, or persist from day one? Leaning client-only (simpler, no schema change) — revisit when sticker / share-card features land.
- **Drag fallback:** keep rectangle authoring as an explicit long-press / "manual" mode, or rip it out once SAM is in? Lean toward keeping for the first ship — too risky to remove without real usage data.
- **`cropped + original` to Gemini:** new pipeline shape vs. existing single-crop input. Validate in a separate notebook cell first — does the hero-image / categorize quality actually improve when Gemini sees both? If not, don't add complexity.

## 9. Done criteria

Prototype is "done enough to spec a branch" when:

- Notebook produces a side-by-side grid showing MobileSAM masks across all canonical + adversarial photos.
- HTML demo runs tap-to-mask under 500 ms on an iPhone 14, end-to-end (no warmup steals).
- Decision cell in the notebook names one model + a one-paragraph reason.
- A separate cell shows the `cropped + original` → Gemini composite call working on one item, with a visual comparison vs. the current single-crop pipeline.

Promote the relevant findings into `notes/ai-generated/segmentation-3d-video-research.md` §1 (and the branch spec) once those four conditions hold.
