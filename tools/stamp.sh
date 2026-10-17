#!/usr/bin/env bash
# Run before deploying site/: ties the page to this commit's files. ?v=dev in index.html and in the modules' imports
# becomes ?v=<commit>, and the service worker's cache is named after the commit, so a phone never runs a new page
# with an old script still in its HTTP cache. Used by both deploy workflows.
set -euo pipefail
cd "$(dirname "$0")/../site"
v="${GITHUB_SHA:?GITHUB_SHA is not set}"; v="${v::8}"
sed -i "s/?v=dev/?v=$v/g" index.html js/app/*.js
if grep -rn "?v=dev" index.html js/app; then exit 1; fi
sed -i "s/anon-chat-dev/anon-chat-$v/" sw.js
grep -c "?v=$v" index.html
