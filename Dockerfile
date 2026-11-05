# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM oven/bun:latest AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
ENV NODE_ENV=production

# El modelo ONNX se descarga en runtime al primer uso (volumen externo).
# No se incluye en la imagen para mantenerla liviana.
RUN bunx prisma generate

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM oven/bun:latest
WORKDIR /app

# Solo copiamos lo necesario para el runtime
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./
COPY --from=builder /app/bunfig.toml ./

ENV NODE_ENV=production
# DATABASE_URL se inyecta por env en docker compose o deploy
# MODEL_CACHE_DIR apunta al volumen persistente
ENV MODEL_CACHE_DIR=/app/.model-cache
ENV PORT=3091

EXPOSE 3091

# Healthcheck interno — sonda nativa de Bun (wget/curl no existen en oven/bun:latest)
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD bun -e 'fetch("http://localhost:3091/health").then(async (r) => { const j = await r.json().catch(() => ({})); process.exit(r.ok && j.status === "ok" ? 0 : 1) }).catch(() => process.exit(1))'

CMD ["bun", "run", "src/index.ts"]
