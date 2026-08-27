FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
# Current docker CLI (Debian's docker.io speaks API 1.41, which the fleet
# box daemon refuses) so the processor can `docker exec` into openclaw-*.
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
CMD ["node", "dist/index.js"]
