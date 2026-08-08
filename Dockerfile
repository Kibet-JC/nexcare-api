# NexCare API production image.
#
# Multi-stage: a build stage compiles TypeScript and generates the Prisma client,
# then a slim runtime stage carries only what's needed to serve and to run
# `prisma migrate deploy` at deploy time.
#
# Base image is node:20-slim (Debian Bookworm), NOT alpine: Prisma's query engine
# needs OpenSSL, and the musl/alpine combination is a known source of engine
# load failures. Both stages share the same base so the Prisma engine binary
# generated in the build stage matches the runtime's libc and OpenSSL exactly.

# ---------- build stage ----------
FROM node:20-slim AS build

# node:20-slim does NOT ship OpenSSL. Without it, `prisma generate` cannot detect
# the libssl version and silently falls back to an openssl-1.1.x engine, which
# then fails to load at runtime on Bookworm (OpenSSL 3.0). Installing openssl
# here makes Prisma generate the correct debian-openssl-3.0.x engine.
# ca-certificates is included for outbound TLS (e.g. an sslmode DATABASE_URL).
#
# python3 and build-essential are for argon2 (0.45.0), which ships no usable
# prebuilt binary for this platform. Its install script falls back to node-gyp,
# and node:20-slim has neither Python nor a C toolchain, so `pnpm install` fails
# with "gyp ERR! find Python". BUILD STAGE ONLY: the runtime stage copies
# node_modules wholesale from here, so the compiled .node binding travels with
# it and the runtime image stays free of compilers.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends \
       openssl ca-certificates python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

# Corepack ships with Node 20 and pins the pnpm version from package.json's
# "packageManager" field, so the build uses the same pnpm as local dev and CI.
RUN corepack enable

WORKDIR /app

# Install dependencies first, on their own layer, so edits to source don't bust
# the dependency cache. --frozen-lockfile fails the build if the lockfile is out
# of sync rather than silently resolving new versions.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Prisma schema is needed before `prisma generate` (run inside `pnpm build`).
COPY prisma ./prisma

# Application source and the build TS config.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

# Static public assets. Not compiled by tsc (rootDir is src/), so they are
# copied verbatim and must be carried into the runtime stage separately.
COPY public ./public

# `pnpm build` = prisma generate (writes the client + engine into node_modules)
# followed by tsc -> dist/. Generating here, on the runtime base image, is what
# guarantees the engine binary is correct for the runtime stage.
RUN pnpm build

# ---------- runtime stage ----------
FROM node:20-slim AS runtime

# OpenSSL again: the runtime needs libssl present for the Prisma query engine
# (the app) and the prisma CLI (`migrate deploy`) to load their engine binaries.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Corepack so `pnpm prisma migrate deploy` (the Railway preDeploy step) and
# `pnpm create-admin:prod` (the one-off bootstrap) are runnable in the container.
RUN corepack enable

ENV NODE_ENV=production
WORKDIR /app

# Bring over package manifests so pnpm can resolve the `prisma`/`start` scripts
# and so `pnpm` knows the package context for the preDeploy migration.
COPY --from=build /app/package.json /app/pnpm-lock.yaml ./

# node_modules is copied wholesale from the build stage rather than reinstalled
# with --prod. The preDeploy step runs `prisma migrate deploy`, so the prisma
# CLI (a devDependency) MUST be present in the image; pnpm's symlinked store
# makes cherry-picking a single dev package unreliable, so we ship the resolved
# tree intact. It already contains the generated @prisma/client and its engine.
COPY --from=build /app/node_modules ./node_modules

# The compiled application.
COPY --from=build /app/dist ./dist

# Static assets served at runtime (RFC 9116 security.txt). app.ts resolves this
# directory relative to its own module URL, so dist/ and public/ must stay
# siblings here exactly as they are in the repository.
COPY --from=build /app/public ./public

# Prisma schema + committed migrations: required at deploy time so
# `prisma migrate deploy` can apply pending migrations against the Railway
# database before the server starts serving.
COPY --from=build /app/prisma ./prisma

# Railway injects PORT; the app's env validation coerces it. Documented here for
# local `docker run`; Railway overrides it at deploy time.
EXPOSE 3000

# Serve the compiled entrypoint directly with node — no tsx, no build tooling in
# the running container.
CMD ["node", "dist/index.js"]
