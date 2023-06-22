FROM node:20-alpine AS builder
WORKDIR /build
COPY . .
RUN npm install  
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/package.json ./package.json
COPY --from=builder /build/package-lock.json ./package-lock.json
COPY --from=builder /build/openapi.yaml ./openapi.yaml
RUN npm install --omit=dev

CMD ["node", "dist/index.mjs"]
EXPOSE 8080