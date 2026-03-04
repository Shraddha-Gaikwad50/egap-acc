#!/bin/sh
# Construct DATABASE_URL using the injected DB_PASSWORD secret
if [ -n "$DB_PASSWORD" ]; then
  echo "🔐 Constructing DATABASE_URL from secrets..."
  if [ -n "$DB_SOCKET_PATH" ]; then
    # Cloud Run (Unix Socket)
    export DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@localhost/${DB_NAME}?host=${DB_SOCKET_PATH}"
  else
    # Local/TCP
    export DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST:-localhost}:5432/${DB_NAME}"
  fi
fi

# Run the passed command
exec "$@"
