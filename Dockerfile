FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build --chown=node:node /app/dist-node ./dist-node
COPY --from=build --chown=node:node /app/dist-web ./dist-web
COPY --from=build --chown=node:node /app/database ./database
RUN mkdir -p /app/data/whatsapp-session /app/data/telegram \
  && chown -R node:node /app/data
USER node
EXPOSE 3001 3010 3020
CMD ["node", "dist-node/api/server.js"]
