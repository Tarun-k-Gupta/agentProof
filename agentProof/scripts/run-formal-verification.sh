#!/usr/bin/env bash
#
# Runs SMTChecker over the policy state machine and writes proofs/*.json.
#
# Two runs, and the second matters as much as the first:
#   PolicySpec        must verify
#   PolicySpecBroken  must NOT verify, and must produce a counterexample
#
# A green result on the broken contract means the checker is not actually
# running, which would make the green result on the real one meaningless.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p artifacts/smt proofs

SOLC="${SOLC:-solc}"
TIMEOUT_MS="${SMT_TIMEOUT_MS:-120000}"

if ! command -v "$SOLC" >/dev/null 2>&1; then
  echo "error: solc not found on PATH." >&2
  echo "  install with: pip install solc-select && solc-select install 0.8.28 && solc-select use 0.8.28" >&2
  exit 127
fi

echo "==> solc: $($SOLC --version | tail -1)"

run_check () {
  local contract="$1" source="$2" log="$3"
  echo "==> checking ${contract}"
  # solc exits non-zero when it reports a violated assertion, which is the
  # expected outcome for the broken variant. Capture rather than propagate.
  set +e
  "$SOLC" \
    --model-checker-engine chc \
    --model-checker-targets assert,overflow,underflow \
    --model-checker-timeout "$TIMEOUT_MS" \
    --model-checker-show-unproved \
    --model-checker-invariants contract \
    --model-checker-contracts "${source}:${contract}" \
    --base-path . --include-path contracts \
    "$source" 2>&1 | tee "$log"
  set -e
}

START=$(date +%s%3N)
run_check PolicySpec contracts/formal/PolicySpec.sol artifacts/smt/raw.log
ELAPSED=$(( $(date +%s%3N) - START ))

run_check PolicySpecBroken contracts/formal/PolicySpecBroken.sol artifacts/smt/broken.log

node scripts/parse-smt-output.mjs \
  --proven artifacts/smt/raw.log \
  --broken artifacts/smt/broken.log \
  --elapsed "$ELAPSED" \
  --out proofs

echo
echo "==> proofs written:"
cat proofs/summary.json
