#!/bin/bash
# Verify that a checkout requesting an object filter, but backed by the
# git mirror, is a regular clone that only stores the objects the mirror
# lacked. Usage: verify-mirror-no-filter.sh <workspace>
set -euo pipefail

ws="$1"
cd "$ws"

# No partial-clone state: no promisor packs, no promisor remote
if ls .git/objects/pack/*.promisor >/dev/null 2>&1; then
  echo "$ws: unexpected promisor pack"
  exit 1
fi
if git config --local --get remote.origin.promisor >/dev/null \
   || git config --local --get remote.origin.partialclonefilter >/dev/null; then
  echo "$ws: unexpected partial clone configuration"
  exit 1
fi

# Only the objects the mirror lacked may live in the workspace
in_pack=$(git count-objects -v | awk '/^in-pack:/ {print $2}')
loose=$(git count-objects -v | awk '/^count:/ {print $2}')
echo "$ws: $in_pack packed + $loose loose local objects"
if [ "$((in_pack + loose))" -gt 1000 ]; then
  echo "$ws: mirror history was copied into the workspace"
  exit 1
fi

git fsck --connectivity-only --no-dangling
echo "$ws: verified"
