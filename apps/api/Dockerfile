FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps/api apps/api
RUN npm run build -w @nexusflow/api
FROM build AS prod-deps
RUN npm prune --omit=dev

FROM node:24-bookworm-slim
# Parches de SO al construir y sin npm/npx en runtime (solo se ejecuta `node`; sus dependencias empaquetadas acumulan CVE).
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app/apps/api
COPY --from=prod-deps --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./dist
COPY --from=build --chown=node:node /app/apps/api/prisma ./prisma
ENV NODE_OPTIONS=--max-old-space-size=384
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
