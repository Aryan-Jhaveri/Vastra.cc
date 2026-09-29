# Vastra dev tasks. `make` or `make help` lists targets.
# npm scripts stay the source of truth for single commands; this file chains
# them into the checks a branch must pass before review / merge.

SHELL := /bin/bash
APP   := src/transport/web/app
STAGE ?= next

.DEFAULT_GOAL := help
.PHONY: help test test-selfhost web-test web-tsc check secrets review smoke smoke-selfhost smoke-hosted compose-check gateway-check migrate-fresh setup create-admin sweep-images backup-images restore-images stages v2

help: ## List targets
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2}'

# ── Checks ───────────────────────────────────────────────────────────────────

test: ## Backend vitest (test/**), hosted mode (HOSTED_MODE=true)
	npx vitest run

test-selfhost: ## Backend vitest as self-host: HOSTED_MODE unset, test/hosted/** skipped
	npx vitest run --config vitest.selfhost.config.ts

web-test: ## Frontend vitest (jsdom)
	cd $(APP) && npx vitest run

web-tsc: ## Frontend typecheck with no cache — what Render's `npm run build` sees
	cd $(APP) && rm -f tsconfig.tsbuildinfo && npx tsc -b --force

check: test test-selfhost web-test web-tsc ## All tests (both backend modes) + clean frontend typecheck

secrets: ## gitleaks over staged changes
	gitleaks git --staged --redact --no-banner .

review: ## Staged diff summary + secrets + check (run on an agent's staged branch)
	@echo "branch: $$(git branch --show-current)"
	@git status --short | grep -v '^??' || true
	@git diff --staged --stat
	@$(MAKE) --no-print-directory secrets
	@$(MAKE) --no-print-directory check

# ── Boot smoke tests (production entrypoint, scrubbed env) ──────────────────

smoke-selfhost: ## Self-host boot: no keys, HOSTED_MODE off, billing unmounted
	scripts/smoke-boot.sh selfhost

smoke: smoke-selfhost ## Boot smoke test

compose-check: ## Self-host compose invariants (profiles, GPU shares, published ports) — needs Docker
	node scripts/check-compose.mjs

gateway-check: ## Run the Caddy gateway against an echo upstream: auth, prefix strip, key swap — needs Docker
	scripts/check-gateway.sh

setup: ## Self-host: pick AI providers + sign-up policy, test connections, write .env. TARGET=docker|node|render ENV_FILE=path
	@DOTENV_CONFIG_PATH=/dev/null node --import tsx scripts/setup.ts $(if $(TARGET),--target $(TARGET),) $(if $(ENV_FILE),--out $(ENV_FILE),)

backup-images: ## Image backup to R2 (#260; nightly with the DB backup). FULL=1 re-uploads everything
	@node --env-file-if-exists=.env --import tsx scripts/image-backup.ts sync $(if $(filter 1,$(FULL)),--full,)

restore-images: ## Write back backed-up images missing on disk (#260): dry run by default. APPLY=1 writes; USER_ID=id
	@node --env-file-if-exists=.env --import tsx scripts/image-backup.ts restore $(if $(filter 1,$(APPLY)),--apply,) $(if $(USER_ID),--user $(USER_ID),)

sweep-images: ## Orphaned image files (#362): dry run by default. APPLY=1 deletes; DAYS=N grace (default 30); USER_ID=id
	@node --env-file-if-exists=.env --import tsx scripts/sweep-images.ts $(if $(filter 1,$(APPLY)),--apply,) $(if $(DAYS),--days $(DAYS),) $(if $(USER_ID),--user $(USER_ID),)

create-admin: ## Self-host: the first admin + a one-time sign-in link. make create-admin EMAIL=you@example.com
	@test -n "$(EMAIL)" || { echo "usage: make create-admin EMAIL=you@example.com"; exit 2; }
	@node --env-file-if-exists=.env --import tsx src/db/migrate.ts
	@node --env-file-if-exists=.env src/transport/web/admin/admin.mjs create-admin "$(EMAIL)"

migrate-fresh: ## Apply every migration to an empty temp DB
	@d=$$(mktemp -d); trap 'rm -rf "$$d"' EXIT; \
	  CLOSET_DATA_DIR=$$d DOTENV_CONFIG_PATH=/dev/null npx tsx src/db/migrate.ts

