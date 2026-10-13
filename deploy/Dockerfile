FROM node:22-bookworm-slim

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-cryptography ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.33.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json VERSION ./
COPY packages packages
COPY verifiers verifiers
COPY scripts scripts
RUN pnpm install --frozen-lockfile

ENV BIND_HOST=0.0.0.0
ENV PORT=8787
ENV PAPER_TEST_ONLY=1
EXPOSE 8787
CMD ["pnpm", "exec", "tsx", "packages/server/src/main.ts"]
