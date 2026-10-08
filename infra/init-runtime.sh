#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=runtime_user="$RUNTIME_DB_USER" --set=runtime_password="$RUNTIME_DB_PASSWORD" <<'SQL'
CREATE ROLE :"runtime_user" LOGIN PASSWORD :'runtime_password';
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
