# Production image: one process serving the web app and the realtime server.
#   docker build -t liveboard .
#   docker run -p 8080:8080 -v liveboard-data:/app/data liveboard
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /app /app
EXPOSE 8080
VOLUME /app/data
CMD ["node", "node_modules/tsx/dist/cli.mjs", "server/src/index.ts"]
