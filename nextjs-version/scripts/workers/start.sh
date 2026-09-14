#!/bin/sh
set -eu
# Refuse to process documents without a current, usable signature database.
freshclam --stdout
freshclam --daemon &
exec node --conditions=react-server document-worker.cjs
