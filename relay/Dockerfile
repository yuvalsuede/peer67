FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --production=false
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --production
COPY --from=builder /app/dist ./dist
ENV NODE_ENV=production
ENV PORT=3967
EXPOSE 3967
CMD ["node", "dist/index.js"]
