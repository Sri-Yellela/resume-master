#!/bin/bash
  echo "=== SYNTAX CHECK ==="
  node --check server.js 2>&1
  echo ""
  echo "=== SERVICE FILES ==="
  find services routes -name "*.js" \
    -exec node --check {} \; 2>&1
  echo ""
  echo "=== FILE EXISTS CHECK ==="
  ls -la services/ 2>&1
  ls -la routes/ 2>&1
  ls -la data/ 2>&1
  echo ""
  echo "=== RECENT COMMITS ==="
  git log --oneline -8
  echo ""
  echo "=== STARTUP ERROR ==="
  timeout 10 node server.js 2>&1 | head -60