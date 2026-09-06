// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title PolicyLib
 * @notice The deterministic policy state machine enforced inside the account's
 *         execution path. Deliberately pure: no external calls, no dynamic
 *         arrays, no storage mappings. That is what makes it tractable for
 *         SMTChecker's CHC engine (see contracts/formal/PolicySpec.sol).
 *
 * @dev Formally verified properties:
 *        P_MAX_TRANSFER    outflow_i <= maxTransaction, for every i
 *        P_DAILY_SPEND     sum(outflow within one UTC day) <= dailyLimit
 *        P_WINDOW_FORWARD  the window day never moves backwards
 *
 *      Known accepted behaviour (threat T6): the daily window is a UTC-day
 *      bucket, not a rolling 24h window. Two full daily limits may be spent one
 *      minute apart across a UTC midnight. Documented, not fixed.
 */
library PolicyLib {
    struct Limits {
        uint256 maxTransaction; // per-operation ceiling, asset base units
        uint256 dailyLimit; // per-UTC-day ceiling, asset base units
    }

    struct Window {
        uint64 day; // block.timestamp / 1 days at last write
        uint256 spent; // cumulative outflow recorded within `day`
    }

    error ExceedsMaxTransaction(uint256 amount, uint256 limit);
    error ExceedsDailyLimit(uint256 wouldBe, uint256 limit);
    error WindowMovedBackwards(uint64 stored, uint64 provided);

    /**
     * @notice Pure state transition. Reverts iff the spend is not permitted.
     * @param w      current window for the account
     * @param l      the account's limits
     * @param amount MEASURED outflow (balance delta), never a declared amount
     * @param today  block.timestamp / 1 days
     * @return next  the window to commit
     */
    function applySpend(Window memory w, Limits memory l, uint256 amount, uint64 today)
        internal
        pure
        returns (Window memory next)
    {
        if (today < w.day) revert WindowMovedBackwards(w.day, today);
        if (amount > l.maxTransaction) revert ExceedsMaxTransaction(amount, l.maxTransaction);

        uint256 base = (w.day == today) ? w.spent : 0; // UTC-day reset
        uint256 wouldBe = base + amount; // 0.8.x checked add

        if (wouldBe > l.dailyLimit) revert ExceedsDailyLimit(wouldBe, l.dailyLimit);

        next = Window({day: today, spent: wouldBe});

        // --- Verified properties ------------------------------------------
        assert(amount <= l.maxTransaction); // P_MAX_TRANSFER
        assert(next.spent <= l.dailyLimit); // P_DAILY_SPEND
        assert(next.day >= w.day); // P_WINDOW_FORWARD
        // ------------------------------------------------------------------
    }

    /// @notice Non-reverting view of the remaining daily allowance.
    function remainingToday(Window memory w, Limits memory l, uint64 today) internal pure returns (uint256) {
        uint256 base = (w.day == today) ? w.spent : 0;
        return base >= l.dailyLimit ? 0 : l.dailyLimit - base;
    }
}
