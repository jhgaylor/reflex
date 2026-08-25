# One process: Bun serves the built SPA and the API that holds the Fountain
# key, the database, and the watcher that keeps the jobs board current while
# nobody has a tab open. The bundle is built by CI before docker build.
FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY server/ ./server/
COPY shared/ ./shared/
COPY dist/ ./dist/
USER bun
EXPOSE 8080
CMD ["bun", "server/index.ts"]
