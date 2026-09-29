# Stage 1: Build React SPA
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend
COPY src/transport/web/app/package*.json ./
RUN npm ci
COPY src/transport/web/app/ .
RUN npm run build

# Stage 2: Production runtime
# better-sqlite3 native bindings are compiled here for the runtime platform
FROM node:22-alpine AS runner
WORKDIR /app

# Install build tools needed for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++

COPY package*.json ./
# Lockfile-exact prod install. tsx is a production dependency (pinned by the
# lockfile) so the runtime never fetches it from the registry at boot.
RUN npm ci --omit=dev

COPY src/ src/
# Operator scripts that run inside the container (Render Shell, docker compose
# run): make setup, the orphaned-image sweep and image backup / restore.
COPY scripts/setup.ts scripts/sweep-images.ts scripts/image-backup.ts scripts/

# Copy built SPA from Stage 1
COPY --from=frontend-builder /app/frontend/dist src/transport/web/app/dist

ENV NODE_ENV=production
ENV CLOSET_DATA_DIR=/data
EXPOSE 3000

# combined.ts starts the Express web server (the Telegram transport is
# deprecated and no longer imported). Runs the locally-installed tsx —
# never npx, which would download an unpinned binary at container start.
CMD ["node", "--import", "tsx", "src/combined.ts"]
