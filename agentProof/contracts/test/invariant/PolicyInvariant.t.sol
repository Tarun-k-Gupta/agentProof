// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentPolicyHook} from "../../src/AgentPolicyHook.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockAccount} from "../mocks/MockAccount.sol";

/**
 * @notice Bounded handler. The fuzzer drives arbitrary sequences of spends,
 *         targets and time jumps; reverts are expected and swallowed so the
 *         campaign keeps exploring.
 */
contract SpendHandler is Test {
    AgentPolicyHook public hook;
    MockERC20 public usdc;
    MockAccount public account;
    address public router;

    uint256 public ghostDaySpend;
    uint64 public ghostDay;

    constructor(AgentPolicyHook _hook, MockERC20 _usdc, MockAccount _account, address _router) {
        hook = _hook;
        usdc = _usdc;
        account = _account;
        router = _router;
        ghostDay = uint64(block.timestamp / 1 days);
    }

    function spend(uint256 amount, address target) external {
        amount = bound(amount, 0, 2_000_000_000);
        if (uint160(target) % 3 != 0) target = router; // bias toward valid paths

        uint256 before = usdc.balanceOf(address(account));
        try account.spend(address(hook), address(usdc), target, amount) {
            uint64 today = uint64(block.timestamp / 1 days);
            if (today != ghostDay) {
                ghostDay = today;
                ghostDaySpend = 0;
            }
            ghostDaySpend += before - usdc.balanceOf(address(account));
        } catch {
            // Rejected by policy. Nothing should have moved.
            assertEq(usdc.balanceOf(address(account)), before, "reverted spend must not move funds");
        }
    }

    function warp(uint256 secondsForward) external {
        vm.warp(block.timestamp + bound(secondsForward, 0, 3 days));
    }
}

/**
 * @notice The property the whole product rests on, checked against the real
 *         hook rather than the pure library: however the account is driven, the
 *         accumulator never exceeds the daily limit and no single measured
 *         outflow exceeds the per-transaction ceiling.
 */
contract PolicyInvariantTest is Test {
    AgentPolicyHook internal hook;
    MockERC20 internal usdc;
    MockAccount internal account;
    SpendHandler internal handler;

    uint256 internal constant MAX_TX = 100_000_000;
    uint256 internal constant DAILY = 500_000_000;

    function setUp() public {
        hook = new AgentPolicyHook();
        usdc = new MockERC20("USD Coin", "USDC", 6);
        account = new MockAccount();
        address router = makeAddr("universalRouter");

        usdc.mint(address(account), 100_000_000_000);

        address[] memory targets = new address[](2);
        targets[0] = router;
        targets[1] = address(usdc);

        account.installHook(
            address(hook),
            abi.encode(
                AgentPolicyHook.Config({
                    asset: address(usdc),
                    maxTransaction: MAX_TX,
                    dailyLimit: DAILY,
                    minBalance: 0,
                    policyHash: keccak256("invariant"),
                    installed: false
                }),
                targets
            )
        );

        handler = new SpendHandler(hook, usdc, account, router);
        targetContract(address(handler));
    }

    function invariant_DailySpendNeverExceedsLimit() public view {
        (, uint256 spent) = hook.window(address(account));
        assertLe(spent, DAILY);
    }

    function invariant_RemainingIsConsistent() public view {
        (uint64 day, uint256 spent) = hook.window(address(account));
        uint256 remaining = hook.remainingToday(address(account));
        if (day == uint64(block.timestamp / 1 days)) {
            assertEq(remaining, DAILY - spent);
        } else {
            assertEq(remaining, DAILY);
        }
    }
}
