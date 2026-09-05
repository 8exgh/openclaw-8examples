FROM node:22-alpine
RUN apk add --no-cache docker-cli
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server ./server
ENV HOST=0.0.0.0 PORT=8795
EXPOSE 8795
CMD ["node", "server/index.mjs"]
