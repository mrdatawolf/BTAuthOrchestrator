FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/copy-console-assets.js ./scripts/copy-console-assets.js
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production BT_CONTAINER_MODE=1 PGLITE_DATA_DIR=/data
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
