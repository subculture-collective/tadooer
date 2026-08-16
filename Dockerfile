# syntax=docker/dockerfile:1.7
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS build

WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.js ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/caldav/package.json packages/caldav/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/import-export/package.json packages/import-export/package.json
COPY packages/google-calendar/package.json packages/google-calendar/package.json
COPY packages/persistence/package.json packages/persistence/package.json
COPY packages/test-support/package.json packages/test-support/package.json
RUN pnpm install --frozen-lockfile

COPY apps/server apps/server
COPY apps/web apps/web
COPY packages packages
RUN pnpm --filter @suite/web build && pnpm --filter @suite/server build

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runtime

ARG SUITE_VERSION=0.0.0-dev
ARG SUITE_REVISION=development
ARG SUITE_BUILD_DATE

LABEL org.opencontainers.image.title="Productivity Suite" \
  org.opencontainers.image.version="$SUITE_VERSION" \
  org.opencontainers.image.revision="$SUITE_REVISION"

ENV HOST=0.0.0.0 \
  PORT=8080 \
  SUITE_DATABASE_PATH=/data/suite.sqlite \
  SUITE_CREDENTIAL_KEY_PATH=/data/credential.key \
  SUITE_WEB_ROOT=/app/web \
  BAIKAL_ENDPOINT=http://baikal/dav.php/ \
  SUITE_SECURE_COOKIES=false \
  SUITE_VERSION=$SUITE_VERSION \
  SUITE_REVISION=$SUITE_REVISION \
  SUITE_BUILD_DATE=$SUITE_BUILD_DATE

WORKDIR /app
RUN mkdir -p /app/web /data/backups && chown -R node:node /app /data
COPY --from=build --chown=node:node /workspace/apps/server/dist /app/server
COPY --from=build --chown=node:node /workspace/apps/web/dist /app/web

USER node
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD ["node", "-e", "const http=require('node:http');const origin=new URL(process.env.SUITE_PUBLIC_ORIGIN||'http://127.0.0.1:8080');const request=http.get({host:'127.0.0.1',port:8080,path:'/api/ready',headers:{Host:origin.host}},response=>process.exit(response.statusCode===200?0:1));request.on('error',()=>process.exit(1))"]

CMD ["node", "/app/server/main.mjs"]
