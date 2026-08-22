# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
# migrations need mysql2 + drizzle-orm at runtime (standalone bundles them
# into server chunks, so they are not in the traced node_modules)
RUN npm install --omit=dev --no-save mysql2 drizzle-orm
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# migrations run at container start before the server boots
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/drizzle ./drizzle
CMD ["sh", "-c", "node scripts/migrate.mjs && exec node server.js"]
