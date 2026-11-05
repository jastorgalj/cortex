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

# Solo copiamos lo necesario para el runtime, con ownership no-root (bun:bun)
COPY --from=builder --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/src ./src
COPY --from=builder --chown=bun:bun /app/prisma ./prisma
COPY --from=builder --chown=bun:bun /app/package.json ./
COPY --from=builder --chown=bun:bun /app/bunfig.toml ./
COPY --from=builder --chown=bun:bun /app/docker-entrypoint.sh ./

ENV NODE_ENV=production
# DATABASE_URL se inyecta por env en docker compose o deploy
# MODEL_CACHE_DIR apunta al volumen persistente
ENV MODEL_CACHE_DIR=/app/.model-cache
ENV PORT=3091

# El modelo ONNX se descarga en /app/.model-cache: el usuario no-root debe poder
# escribir ahí (el volumen montado hereda el ownership de la imagen).
RUN mkdir -p /app/.model-cache && chown bun:bun /app/.model-cache && chmod +x /app/docker-entrypoint.sh

USER bun

EXPOSE 3091

# Healthcheck interno — sonda nativa de Bun (wget/curl no existen en oven/bun:latest).
# start_period amplio: el primer arranque descarga ~420 MB del modelo.
HEALTHCHECK --interval=30s --timeout=10s --start-period=300s --retries=3 \
  CMD bun -e 'fetch("http://localhost:3091/health").then(async (r) => { const j = await r.json().catch(() => ({})); process.exit(r.ok && j.status === "ok" ? 0 : 1) }).catch(() => process.exit(1))'

# El entrypoint aplica las migraciones pendientes y luego arranca el servidor.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["bun", "run", "src/index.ts"]
