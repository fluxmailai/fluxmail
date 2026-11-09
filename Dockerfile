# syntax=docker/dockerfile:1
FROM node:22-slim AS deps
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/provider-gmail/package.json packages/provider-gmail/
COPY packages/provider-imap/package.json packages/provider-imap/
COPY packages/provider-outlook/package.json packages/provider-outlook/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages ./packages
COPY test/fixtures ./test/fixtures

# Compiles the packages from source. The release workflow replaces the
# package-builds stage with its validated build output by passing
# `--build-context package-builds=<dir>`, so this stage does not run there.
FROM deps AS compile
RUN pnpm build && \
    for dist in packages/*/dist; do mkdir -p "/package-builds/$(dirname "$dist")" && cp -R "$dist" "/package-builds/$dist"; done

FROM scratch AS package-builds
COPY --from=compile /package-builds/ /

FROM deps AS build
COPY --from=package-builds /packages/ ./packages/
RUN for package in packages/*/; do \
      test -d "${package}dist" || { echo "Missing build output: ${package}dist" >&2; exit 1; }; \
    done && \
    pnpm --filter fluxmail deploy --legacy --prod /out

FROM node:22-slim
LABEL org.opencontainers.image.source="https://github.com/fluxmailai/fluxmail" \
      org.opencontainers.image.description="Fluxmail: a self-hosted email API with MCP and REST support"
ENV NODE_ENV=production \
    FLUXMAIL_DATA_DIR=/data \
    FLUXMAIL_PORT=8977
WORKDIR /app
COPY --from=build /out ./
COPY LICENSE.md ./LICENSE.md
RUN chmod +x dist/cli.js && ln -s /app/dist/cli.js /usr/local/bin/fluxmail && \
    mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8977
USER node
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
