FROM node:24-alpine

WORKDIR /app

# Install production dependencies only (reproducible lockfile).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Application code (TS runs on Node 24 native type-stripping).
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# The container is responsible for running migrations/seed before serving.
CMD ["sh", "-c", "node scripts/db-setup.ts && node src/api/server.ts"]
