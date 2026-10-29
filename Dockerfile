FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/copy-console-assets.js ./scripts/copy-console-assets.js
RUN npm run build

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS runtime
ENV NODE_ENV=production BT_CONTAINER_MODE=1 PGLITE_DATA_DIR=/data/pglite PORT=3210
ARG VERSION=0.9.0
ARG REVISION
LABEL org.opencontainers.image.source="https://github.com/mrdatawolf/BTAuthOrchestrator" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force && mkdir /data && chmod 700 /data
COPY --from=build /app/dist/ ./dist/
COPY scripts/ ./scripts/
# No VOLUME: Docker must not silently supply an anonymous /data volume.
# /data remains root-owned unless the operator supplies the required mount.
USER 568:568
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "scripts/container-healthcheck.js"]
ENTRYPOINT ["/bin/sh", "scripts/container-entrypoint.sh"]
