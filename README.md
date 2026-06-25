<div align="center">

# Vastra

**Your personal stylist. Your personal inventory. Your personal smart wardrobe.**

[![Vastra Demo](https://img.youtube.com/vi/6_iB2oVfOYs/maxresdefault.jpg)](https://youtube.com/shorts/6_iB2oVfOYs)

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React_18-61DAFB?style=flat&logo=react&logoColor=black)](https://reactjs.org/)
[![Gemini](https://img.shields.io/badge/Google_Gemini-4285F4?style=flat&logo=google&logoColor=white)](https://ai.google.dev/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white)](https://www.docker.com/)

</div>

---

## What is Vastra?

Vastra is an AI-powered wardrobe management app. Photograph your clothes — Vastra categorises them instantly, suggests weather-aware outfits, and lets you virtually try on combinations before you open your closet.

Built as a progressive web app (PWA) installable on any device, it is designed for anyone who wants a smarter relationship with their wardrobe.

---

## Features

### Closet management
- **Photo → AI categorise** — snap a photo; Gemini vision auto-fills category, colour, season, and occasion tags in one step
- **Care-label OCR** — scan the tag on a garment to extract brand, size, material, and care instructions
- **Multi-view gallery** — store front, back, side, and detail shots per item; AI generates a polished hero thumbnail from multiple views
- **Filters** — colour, season, occasion, brand, and custom free-text tags across the full closet grid

### Outfit tools
- **Weather-aware suggestions** — live weather fetch drives outfit recommendations for the conditions right now
- **Outfit builder** — drag items together, set a cover photo, name and occasion-tag the outfit
- **Collections** — curate themed bundles of saved outfits (travel, work, festival, etc.)
- **Inline editing** — rename, retag, and update outfits without leaving the detail view

### Virtual try-on
- Select items from your closet, combine them, and generate an AI try-on image
- Upload ad-hoc garments (online finds, inspiration images) alongside closet items
- Add a natural-language instruction to guide the result (pose, background, style)
- Full try-on history with one-tap save and share

### Discovery & sharing
- **Discover mode** — describe a vibe in words or upload an inspiration image; Vastra surfaces matching outfits from your closet
- **Share links** — send any outfit to a friend via a public link with expiry; no account required to view

### Platform & personalisation
- **Scheduled reminders** — set recurring outfit nudges with push notification delivery
- **Dark mode + themes** — Silk, MONO, and Royal palettes; persisted per account
- **PWA** — installs on iOS, Android, and desktop; full offline read access
- **Multi-user** — full per-user accounts with isolated data, themes, and preferences

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (ESM), Node 20 |
| Database | SQLite + Drizzle ORM |
| AI | Google Gemini (vision + generation + embeddings) |
| Image processing | Sharp |
| Backend | Express v5 |
| Frontend | React 18, Vite, Tailwind CSS v4, Radix UI, Lucide icons |
| Auth | Email + Google OAuth, httpOnly session cookies |
| Scheduling | Croner |
| Push notifications | VAPID + web-push |
| Testing | Vitest + Testing Library (200+ tests) |
| Deploy | Docker + Render |

---

## Architecture

The core — AI, database, and business logic — is transport-agnostic. Any new client (mobile app, CLI, etc.) reuses the same tool functions without touching AI or database code.

```
src/
  ai/         Gemini: categorise, suggest, tryon, heroImage, discover
  db/         SQLite + Drizzle schema and migrations
  storage/    Image compression (Sharp)
  tools/      Core logic shared across all transports
  weather/    Open-Meteo + WMO condition mapping
  transport/
    web/      Express v5 API + React 18 SPA
```

---

## Live demo

Visit [vastra.cc](https://vastra.cc) to try the hosted version.

---

## License

[MIT](./LICENSE)
