# Notebooks

Prototype notebooks written while building Vastra. Each one tested an
approach (item detection, hero images, try-on, tagging, embeddings, ranking)
before any of it went into `src/`.

They're kept with their outputs, so you can read the results without running
them. Some outputs are removed where they contained third-party or personal
photos.

**They won't run as-is.** They import a local helper package and read input
photos and caches that aren't in this repo, and several call paid model APIs.
The code in `src/` is authoritative; these show how it got there.

| Notebooks | Topic |
|---|---|
| 01–04 | Item detection: single, multi-item, multi-angle, box editor |
| 05–06 | Hero image ("Make Pretty") generation and a model bake-off |
| 07, 18 | Virtual try-on bake-off, try-on with scraped product images |
| 08–09 | Vision-model tagging and text-model comparisons |
| 15 | Tap-to-segment in the browser (see `15_tap_to_segment.md`) |
| 16–17, 19 | Product-URL parsing, fit-score calibration, closet matching |
| 20–25 | Decision-model ranking experiments (Jev via OpenRouter, a self-hosted judge) |
