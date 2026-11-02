# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS build
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
RUN pnpm build && pnpm --filter fluxmail deploy --legacy --prod /out

FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
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
