// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PolicyLib} from "../src/lib/PolicyLib.sol";

/**
 * @title PolicySpec
 * @notice SMTChecker harness. The CHC engine explores arbitrary, unbounded
 *         sequences of `step` calls with adversarial arguments and must show
 *         the assertions hold in every reachable state.
 *
 * @dev We verify PolicyLib.evaluate, not the hook. A 7579 hook is full of
 *      external calls, balance reads and cross-contract mappings — CHC loses
 *      precision on those and returns `unknown`. The hook is covered by Foundry
 *      invariant tests instead, and we say so rather than implying the proof
 *      covers it.
 *
 *      Two things about the shape of this harness are load-bearing rather than
 *      incidental, and both were learned the hard way:
 *
 *        - It asserts against `evaluate`'s scalar returns, not against a memory
 *          struct. CHC havocs memory structs and reported `next.day >= w.day`
 *          as violated with a counterexample in which it plainly held.
 *        - There is no try/catch and nothing reverts. An earlier version wrapped
 *          a reverting `step` in `try this.step(...)`, and because SMTChecker
 *          does not model `revert CustomError(...)` as terminating, it explored
 *          the impossible path where a rejected spend continued executing.
 *
 *      Run: scripts/run-formal-verification.sh
 */
contract PolicySpec {
    uint64 private day;
    uint256 private spent;
    uint256 private maxTransaction;
    uint256 private dailyLimit;

    constructor(uint256 maxTx, uint256 daily) {
        require(maxTx > 0, "maxTx must be positive");
        require(daily >= maxTx, "daily must be >= maxTx");
        maxTransaction = maxTx;
        dailyLimit = daily;
    }

    /// @dev Every argument is adversarial: the solver picks amount and today.
    function step(uint256 amount, uint64 today) external {
        uint64 dayBefore = day;
        uint256 spentBefore = spent;

        (PolicyLib.Decision decision, uint64 nextDay, uint256 nextSpent) =
            PolicyLib.evaluate(dayBefore, spentBefore, maxTransaction, dailyLimit, amount, today);

        if (decision == PolicyLib.Decision.Allow) {
            day = nextDay;
            spent = nextSpent;

            // Inductive invariants over the whole reachable state space.
            assert(amount <= maxTransaction); // MAX_TRANSFER
            assert(spent <= dailyLimit); // DAILY_SPEND
            assert(day >= dayBefore); // WINDOW_FORWARD
            assert(day == today); // window commits the current day
        } else {
            // A refused spend must leave the accumulator exactly as it was.
            // This is the property the old try/catch harness was reaching for.
            assert(nextSpent == spentBefore); // NO_MUTATION
            assert(nextDay == dayBefore); // NO_MUTATION
        }
    }
}
