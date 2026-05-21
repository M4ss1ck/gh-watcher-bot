#!/bin/sh
set -e

# Fix ownership of the data directory so the non-root user can write to it.
# This matters when the host bind-mounts a directory that was created by Docker as root.
if [ -d /app/data ]; then
    chown -R bot:bunjs /app/data
fi

exec su-exec bot "$@"
