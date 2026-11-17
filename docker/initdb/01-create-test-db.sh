#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
set -eu
# The application database comes from POSTGRES_DB; tests use a separate
# database on the same development server.
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
  -c "CREATE DATABASE shopping_assistant_test;"
