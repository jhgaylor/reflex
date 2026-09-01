# One process: Bun serves the built SPA and the API that holds the Fountain
# key, the database, and the watcher that keeps the jobs board current while
# nobody has a tab open. The bundle is built by CI before docker build.
#
# The engram binary rides along: it is the memory backend — one child process
# per active brain behind /api/mcp/memory, and the CLI the memory page reads
# through. engram publishes no release artifacts, so CI cross-compiles it
# from source (see build.yml: pinned sha of the private engrambrain/engram
# repo, plus vendor/engram/0001-tls-p256-fallback.patch until that fix is
# merged upstream) into vendor/engram/engram-linux-{amd64,arm64} before this
# build. A static Go binary, so alpine/musl is fine. For a local image build,
# run the same `go build` by hand first.
FROM oven/bun:1-alpine
ARG TARGETARCH
WORKDIR /app
COPY vendor/engram/engram-linux-${TARGETARCH} /usr/local/bin/engram
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY server/ ./server/
COPY shared/ ./shared/
COPY dist/ ./dist/
USER bun
EXPOSE 8080
CMD ["bun", "server/index.ts"]
