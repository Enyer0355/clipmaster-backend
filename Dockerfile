# syntax=docker/dockerfile:1

# ---- Build stage: compile TypeScript, prune dev dependencies ----
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- Runtime stage: node + system ffmpeg (no ffmpeg-static) ----
FROM node:24-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=10000
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Run as the non-root node user; temp files go to /tmp (world-writable).
USER node
EXPOSE 10000
CMD ["node", "dist/index.js"]
