# Production build for EGAP ACC (Agent Command Center)
FROM node:20-slim

# Install OpenSSL for Prisma
RUN apt-get update -y && \
    apt-get install -y openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy Prisma schema and generate client
COPY prisma ./prisma
RUN npx prisma@6.19.2 generate

# Copy source code and build
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Copy static files
COPY public ./public

# Add Entrypoint script for Cloud Run DATABASE_URL construction
COPY entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["entrypoint.sh"]

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "dist/server.js"]
