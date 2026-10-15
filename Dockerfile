ARG NODE_IMAGE=node:24.19.0-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends util-linux ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY schemas ./schemas
RUN ln -s /app/dist/cli.js /usr/local/bin/pi-sentinel && chmod +x /app/dist/cli.js
USER 1000:1000
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--help"]
