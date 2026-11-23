FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
COPY patches ./patches
COPY scripts ./scripts
COPY docs/licenses ./docs/licenses
COPY certs ./certs
RUN node scripts/check-gigachat-ca.mjs
RUN npm ci
COPY tsconfig.node.json vite.config.ts ./
COPY scripts ./scripts
COPY src ./src
COPY web ./web
COPY database ./database
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ARG RELEASE_REVISION=unversioned
LABEL org.opencontainers.image.revision=$RELEASE_REVISION
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
COPY patches ./patches
COPY scripts ./scripts
COPY docs/licenses ./docs/licenses
COPY certs ./certs
RUN node scripts/check-gigachat-ca.mjs
RUN npm ci --omit=dev
COPY --from=build --chown=node:node /app/dist-node ./dist-node
COPY --from=build --chown=node:node /app/dist-web ./dist-web
COPY --from=build --chown=node:node /app/database ./database
RUN mkdir -p /app/data/whatsapp-session /app/data/telegram \
  && chown -R node:node /app/data
USER node
EXPOSE 3001 3010 3020
CMD ["node", "dist-node/api/server.js"]
