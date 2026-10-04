# syntax=docker/dockerfile:1.7
# Whitechain x402 Facilitator — multi-stage build, runs as non-root on Node 22.
#
#   docker build -t whitechain-x402-facilitator .
#   docker run --rm -p 8402:8402 -e FACILITATOR_PRIVATE_KEY=0x... whitechain-x402-facilitator
#
# The signer key is read from the environment at runtime only; nothing secret is baked in.

FROM node:26-alpine AS build
WORKDIR /app
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts

# Stage the runtime tree so the optional landing page (written by the docs build into
# site/landing.html) is included when present and silently skipped when it is not.
FROM node:26-alpine AS stage
WORKDIR /stage
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY . /src
RUN mkdir -p site \
 && if [ -f /src/site/landing.html ]; then cp /src/site/landing.html site/landing.html; fi \
 && if [ -f /src/denylist.txt ]; then cp /src/denylist.txt denylist.txt; fi

FROM node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8402
RUN addgroup -S x402 && adduser -S -G x402 -H x402
COPY --from=stage --chown=x402:x402 /stage ./
USER x402
EXPOSE 8402
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8402)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
