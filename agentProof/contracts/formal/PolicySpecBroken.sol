// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title PolicySpecBroken
 * @notice Identical to PolicySpec except the daily check is off by one and the
 *         UTC-day reset guard is missing. SMTChecker must produce a concrete
 *         counterexample trace here.
 *
 * @dev CI asserts this file DOES fail verification. A green build on this file
 *      means the model checker is not actually running, which would make the
 *      green build on PolicySpec meaningless. This is the difference between
 *      citing a tool and using one.
 */
contract PolicySpecBroken {
    struct Window {
        uint64 day;
        uint256 spent;
    }

    Window private w;
    uint256 private immutable maxTransaction;
    uint256 private immutable dailyLimit;

    constructor(uint256 maxTx, uint256 daily) {
        require(maxTx > 0 && daily >= maxTx);
        maxTransaction = maxTx;
        dailyLimit = daily;
    }

    function step(uint256 amount, uint64 today) external {
        require(today >= w.day);
        if (amount > maxTransaction) revert("max");

        // BUG 1: no UTC-day reset — `base` should be 0 when w.day != today.
        //        Harmless-looking, but combined with BUG 2 it lets the daily
        //        accumulator settle exactly one unit above the limit.
        uint256 base = w.spent;
        uint256 wouldBe = base + amount;

        // BUG 2: `>=` instead of `>` inverts the boundary — an amount landing
        //        exactly on dailyLimit is rejected, and dailyLimit + 1 is not.
        if (wouldBe > dailyLimit + 1) revert("daily");

        w = Window({day: today, spent: wouldBe});

        assert(w.spent <= dailyLimit); // solver finds: wouldBe == dailyLimit + 1
    }
}
