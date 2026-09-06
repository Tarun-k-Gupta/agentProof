// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PolicyLib} from "../src/lib/PolicyLib.sol";

/**
 * @title PolicySpec
 * @notice SMTChecker harness. The CHC engine explores arbitrary, unbounded
 *         sequences of `step` calls with adversarial arguments and must show
 *         the assertions hold in every reachable state.
 *
 * @dev We verify the library, not the hook. A 7579 hook is full of external
 *      calls, balance reads and cross-contract mappings — CHC loses precision
 *      on those and returns `unknown`. The hook is covered by Foundry invariant
 *      tests instead, and we say so rather than implying the proof covers it.
 *
 *      Run: scripts/run-formal-verification.sh
 */
contract PolicySpec {
    PolicyLib.Window private w;
    PolicyLib.Limits private l;

    constructor(uint256 maxTx, uint256 daily) {
        require(maxTx > 0, "maxTx must be positive");
        require(daily >= maxTx, "daily must be >= maxTx");
        l = PolicyLib.Limits(maxTx, daily);
    }

    /// @dev Every argument is adversarial: the solver picks amount and today.
    function step(uint256 amount, uint64 today) external {
        require(today >= w.day, "time moves forward");

        w = PolicyLib.applySpend(w, l, amount, today);

        // Inductive invariants over the whole reachable state space.
        assert(amount <= l.maxTransaction); // MAX_TRANSFER
        assert(w.spent <= l.dailyLimit); // DAILY_SPEND
        assert(w.day == today); // window commits the current day
    }

    /// @dev A step that reverts must leave the accumulator untouched.
    function stepAndCatch(uint256 amount, uint64 today) external {
        uint256 spentBefore = w.spent;
        uint64 dayBefore = w.day;

        try this.step(amount, today) {
            assert(w.spent <= l.dailyLimit);
        } catch {
            assert(w.spent == spentBefore);
            assert(w.day == dayBefore);
        }
    }
}
