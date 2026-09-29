import type { Express, RequestHandler } from 'express'

// Open-source build: the hosted (vastra.cc) extras — wallet billing, Stripe,
// per-user OpenRouter keys, admin metrics — aren't part of this repository.
// These entry points register nothing, so the self-host defaults in
// src/hostedHooks.ts stay in force.

export function registerHostedHooks(): void {}

export function registerHostedPreJsonRoutes(_app: Express): void {}

export function registerHostedRoutes(_app: Express, _mw: {
  requireSession: RequestHandler
  requireAdmin: RequestHandler
  requireCsrfForMutations: RequestHandler
}): void {}
