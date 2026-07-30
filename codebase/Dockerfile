# Dockerfile cho VLearn Tutor app
# Base: Node 20 (LTS) Alpine — image nhỏ, đủ cho prototype

FROM node:20-alpine

# Cài wget cho healthcheck
RUN apk add --no-cache wget bash

WORKDIR /app

# Copy toàn bộ codebase (kèm entrypoint.sh)
COPY . /app/
RUN chmod +x /app/entrypoint.sh

# Expose port server
EXPOSE 3000

# Healthcheck — gọi /api/health để verify server alive
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

# Entrypoint: auto-ingest nếu cần + chạy server
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "server.js"]