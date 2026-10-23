# PASSO — one image, three roles (api / worker / relay).
#
# debian-slim, NOT Alpine: XSD validation needs libxml2 through a native
# binding, and rendering needs the xsltproc binary. Both are fragile on musl,
# and a validation failure here means a rejected tax document.

# ---------------------------------------------------------------- deps stage
# Native addons (libxmljs2) are compiled here, against this image's libc and
# Node ABI. Copying a host-built or builder-built node_modules into a different
# base yields "invalid ELF header" at runtime.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential libxml2-dev \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
# node-pg-migrate is a RUNTIME dependency: the `migrate` service runs from this
# image. It used to be a devDependency added here by a second `npm install`,
# and that install quietly restored the WHOLE dev tree (vitest, vite, eslint,
# typescript…) into the production image — `--omit=dev` applied only to `ci`.
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# --------------------------------------------------------------- check stage
FROM node:22-bookworm-slim AS check
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential libxml2-dev \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN npx tsc --noEmit

# ------------------------------------------------------------- runtime stage
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# xsltproc applies the official AdE stylesheets. The `libxslt` npm package is
# unmaintained and no longer builds against modern V8, so rendering runs as a
# subprocess against the OS package instead. libxml2 is the runtime shared
# library for the libxmljs2 addon — the -dev headers are not needed here.
# `upgrade` pulls Debian security fixes newer than the base image's build.
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends xsltproc libxml2 dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Nothing runs npm at runtime (every service starts with `node`, and the
# migrator resolves its local binary). The npm CLI bundled with the base image
# carries its own dependency tree — and its own CVEs — so it is removed.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
# assets/xsd carries a VENDORED xmldsig-core-schema.xsd: upstream the FatturaPA
# XSD imports it from w3.org, which breaks schema compilation — and therefore
# every submission — on any host without outbound access.
COPY assets ./assets

# A writable HOME is required: npm/node write caches there and fail with
# EACCES on the default /home/<user> when it does not exist.
RUN groupadd -r -g 10001 passo \
    && useradd -r -u 10001 -g passo -m -d /home/passo passo \
    && chown -R passo:passo /app /home/passo
USER passo
ENV HOME=/home/passo

EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--experimental-strip-types", "src/index.ts", "api"]
