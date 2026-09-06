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

# solc's SMTChecker aborts with a std::runtime_error on a locale it does not
# recognise, before it ever reaches the solver. The failure message says nothing
# about locales.
export LC_ALL=C

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

# solc dlopens libz3 by exact soname. A z3 that is installed but a different
# minor version is invisible to it, and the only symptom is a warning buried in
# the compile output followed by an empty proof. Fail here instead.
probe=$(printf '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.28;\ncontract P { function f(uint256 a) external pure { assert(a == a); } }\n')
if printf '%s' "$probe" > artifacts/smt/probe.sol &&
   "$SOLC" --model-checker-engine chc --model-checker-timeout 5000 \
     --model-checker-contracts artifacts/smt/probe.sol:P artifacts/smt/probe.sol 2>&1 |
     grep -q 'CHC analysis was not possible'; then
  echo "error: solc found no Horn solver." >&2
  echo "  solc $($SOLC --version | tail -1 | sed 's/Version: //') dlopens libz3 by exact soname." >&2
  echo "  Install the matching z3 and put it on LD_LIBRARY_PATH, e.g.:" >&2
  echo "    pip install --target /tmp/z3 'z3-solver==4.12.2.0'" >&2
  echo "    export LD_LIBRARY_PATH=/tmp/z3/z3/lib:\$LD_LIBRARY_PATH" >&2
  echo "  Refusing to run: a checker that is not running produces a clean log," >&2
  echo "  which is indistinguishable from a proof unless you look for the warning." >&2
  exit 127
fi
echo "==> Horn solver available"

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
