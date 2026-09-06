// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title PolicyLib
 * @notice The deterministic policy state machine enforced inside the account's
 *         execution path.
 *
 * @dev The library is split in two on purpose.
 *
 *      `evaluate` is the verified core: scalar arguments, scalar returns, no
 *      structs, no reverts, total. `applySpend` is a thin adapter that carries
 *      the struct API the hook uses and turns a rejection into a typed revert.
 *
 *      That split is not stylistic. solc 0.8.28's SMTChecker does not model
 *      `revert CustomError(...)` as terminating a path, so a guard written that
 *      way is invisible to the CHC engine — it explores the state *after* a
 *      revert that cannot happen and reports the assertion that follows as
 *      violated. Memory structs cost it further precision: with both in place,
 *      not one property here could be proved. Written as a total function over
 *      scalars, all of them are.
 *
 *      Formally verified properties (contracts/formal/PolicySpec.sol):
 *        P_MAX_TRANSFER    an allowed spend is never above maxTransaction
 *        P_DAILY_SPEND     an allowed spend never leaves the day's total above
 *                          dailyLimit
 *        P_WINDOW_FORWARD  the window day never moves backwards
 *        P_NO_MUTATION     a rejected spend returns the window unchanged
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

    /// @notice Why a spend was refused, or `Allow`.
    enum Decision {
        Allow,
        ExceedsMaxTransaction,
        ExceedsDailyLimit,
        WindowMovedBackwards
    }

    error ExceedsMaxTransaction(uint256 amount, uint256 limit);
    error ExceedsDailyLimit(uint256 wouldBe, uint256 limit);
    error WindowMovedBackwards(uint64 stored, uint64 provided);

    /**
     * @notice The verified core. Total: it decides, and never reverts.
     * @dev Returning the unchanged window on every rejection path is part of
     *      the specification, not defensive habit — P_NO_MUTATION is what makes
     *      "the accumulator cannot be advanced by a refused spend" checkable.
     *
     * @param day             the stored window day
     * @param spent           cumulative outflow recorded within `day`
     * @param maxTransaction  per-operation ceiling
     * @param dailyLimit      per-UTC-day ceiling
     * @param amount          MEASURED outflow (balance delta), never a declared amount
     * @param today           block.timestamp / 1 days
     */
    function evaluate(
        uint64 day,
        uint256 spent,
        uint256 maxTransaction,
        uint256 dailyLimit,
        uint256 amount,
        uint64 today
    ) internal pure returns (Decision decision, uint64 nextDay, uint256 nextSpent) {
        if (today < day) return (Decision.WindowMovedBackwards, day, spent);
        if (amount > maxTransaction) return (Decision.ExceedsMaxTransaction, day, spent);

        uint256 base = (day == today) ? spent : 0; // UTC-day reset

        // Checked separately rather than relying on 0.8.x's revert-on-overflow,
        // because a revert here would make this function partial again and take
        // the proof with it. An amount that would overflow the accumulator is,
        // in any case, over the daily limit.
        if (amount > type(uint256).max - base) return (Decision.ExceedsDailyLimit, day, spent);

        uint256 wouldBe = base + amount;
        if (wouldBe > dailyLimit) return (Decision.ExceedsDailyLimit, day, spent);

        return (Decision.Allow, today, wouldBe);
    }

    /**
     * @notice Struct-shaped adapter over {evaluate}. Reverts iff the spend is
     *         not permitted.
     * @return next the window to commit
     */
    function applySpend(Window memory w, Limits memory l, uint256 amount, uint64 today)
        internal
        pure
        returns (Window memory next)
    {
        (Decision decision, uint64 nextDay, uint256 nextSpent) =
            evaluate(w.day, w.spent, l.maxTransaction, l.dailyLimit, amount, today);

        if (decision == Decision.WindowMovedBackwards) revert WindowMovedBackwards(w.day, today);
        if (decision == Decision.ExceedsMaxTransaction) revert ExceedsMaxTransaction(amount, l.maxTransaction);
        if (decision == Decision.ExceedsDailyLimit) {
            uint256 base = (w.day == today) ? w.spent : 0;
            revert ExceedsDailyLimit(base + amount, l.dailyLimit);
        }

        next = Window({day: nextDay, spent: nextSpent});
    }

    /// @notice Non-reverting view of the remaining daily allowance.
    function remainingToday(Window memory w, Limits memory l, uint64 today) internal pure returns (uint256) {
        uint256 base = (w.day == today) ? w.spent : 0;
        return base >= l.dailyLimit ? 0 : l.dailyLimit - base;
    }
}
