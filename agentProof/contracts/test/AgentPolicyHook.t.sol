// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentPolicyHook} from "../src/AgentPolicyHook.sol";
import {PolicyLib} from "../src/lib/PolicyLib.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockAccount} from "./mocks/MockAccount.sol";

contract AgentPolicyHookTest is Test {
    AgentPolicyHook internal hook;
    MockERC20 internal usdc;
    MockAccount internal account;

    address internal router = makeAddr("universalRouter");
    address internal attacker = makeAddr("attacker");

    uint256 internal constant MAX_TX = 100_000_000; // 100 USDC
    uint256 internal constant DAILY = 500_000_000; // 500 USDC
    uint256 internal constant MIN_BAL = 10_000_000; // 10 USDC

    function setUp() public {
        hook = new AgentPolicyHook();
        usdc = new MockERC20("USD Coin", "USDC", 6);
        account = new MockAccount();

        usdc.mint(address(account), 1_000_000_000); // 1,000 USDC

        // Allowlist covers both the contracts the account may call and the
        // counterparties it may move the tracked asset to.
        address[] memory targets = new address[](2);
        targets[0] = router;
        targets[1] = address(usdc);

        AgentPolicyHook.Config memory c = AgentPolicyHook.Config({
            asset: address(usdc),
            maxTransaction: MAX_TX,
            dailyLimit: DAILY,
            minBalance: MIN_BAL,
            policyHash: keccak256("agentproof/v1:test"),
            installed: false
        });

        account.installHook(address(hook), abi.encode(c, targets));
    }

    // ------------------------------------------------------------- happy path

    function test_AllowsSpendWithinLimits() public {
        account.spend(address(hook), address(usdc), router, 80_000_000);

        (, uint256 spent) = hook.window(address(account));
        assertEq(spent, 80_000_000, "accumulator should record the measured outflow");
        assertEq(hook.remainingToday(address(account)), DAILY - 80_000_000);
    }

    function test_AccumulatesAcrossOperations() public {
        account.spend(address(hook), address(usdc), router, 40_000_000);
        account.spend(address(hook), address(usdc), router, 40_000_000);

        (, uint256 spent) = hook.window(address(account));
        assertEq(spent, 80_000_000);
    }

    // ------------------------------------------------------------- violations

    /// T1: a hallucinating agent proposes an oversized action.
    function test_RevertsAboveMaxTransaction() public {
        vm.expectRevert(abi.encodeWithSelector(PolicyLib.ExceedsMaxTransaction.selector, 250_000_000, MAX_TX));
        account.spend(address(hook), address(usdc), router, 250_000_000);
    }

    /// T5: salami slicing — 20 x 40 USDC to stay under a 100 per-tx limit.
    function test_RevertsOnSalamiSlicing() public {
        for (uint256 i; i < 12; ++i) {
            account.spend(address(hook), address(usdc), router, 40_000_000);
        }
        // 12 * 40 = 480 spent. The 13th lands at 520 > 500.
        vm.expectRevert(abi.encodeWithSelector(PolicyLib.ExceedsDailyLimit.selector, 520_000_000, DAILY));
        account.spend(address(hook), address(usdc), router, 40_000_000);
    }

    /// T2: prompt injection redirects funds to an attacker address.
    function test_RevertsOnNonAllowlistedTarget() public {
        vm.expectRevert(abi.encodeWithSelector(AgentPolicyHook.TargetNotAllowed.selector, attacker));
        account.spend(address(hook), address(usdc), attacker, 1_000_000);
    }

    /// T4: calldata declares 10 USDC but drains far more. The hook never reads
    ///     the declared amount — only the balance delta — so this is caught.
    function test_MeasuresActualOutflowNotDeclaredAmount() public {
        vm.expectRevert(abi.encodeWithSelector(PolicyLib.ExceedsMaxTransaction.selector, 900_000_000, MAX_TX));
        account.spendDeclaringLess(address(hook), address(usdc), router, 900_000_000, 10_000_000);
    }

    function test_RevertsBelowMinBalance() public {
        // Drain to just above the floor across several in-limit operations…
        for (uint256 i; i < 5; ++i) {
            account.spend(address(hook), address(usdc), router, 100_000_000);
        }
        // …then a further spend on the next day would breach minBalance.
        vm.warp(block.timestamp + 1 days);
        for (uint256 i; i < 4; ++i) {
            account.spend(address(hook), address(usdc), router, 100_000_000);
        }
        vm.expectRevert(abi.encodeWithSelector(AgentPolicyHook.BelowMinBalance.selector, 5_000_000, MIN_BAL));
        account.spend(address(hook), address(usdc), router, 95_000_000);
    }

    // ---------------------------------------------------------- window resets

    function test_DailyWindowResetsAtUtcMidnight() public {
        for (uint256 i; i < 5; ++i) {
            account.spend(address(hook), address(usdc), router, 100_000_000);
        }
        assertEq(hook.remainingToday(address(account)), 0);

        vm.warp(block.timestamp + 1 days);
        assertEq(hook.remainingToday(address(account)), DAILY, "window resets on the UTC day boundary");

        account.spend(address(hook), address(usdc), router, 100_000_000);
        (, uint256 spent) = hook.window(address(account));
        assertEq(spent, 100_000_000);
    }

    // ------------------------------------------------------------ the thesis

    /**
     * The test named in the README. This is the difference between a linter and
     * a safety runtime: no SDK is involved anywhere in this test. The account
     * executes directly and the hook still stops it.
     */
    function test_RejectsExecutionThatBypassesTheSdkEntirely() public {
        vm.expectRevert(abi.encodeWithSelector(PolicyLib.ExceedsMaxTransaction.selector, 250_000_000, MAX_TX));
        account.rawExecute(
            address(hook),
            address(usdc),
            abi.encodeWithSignature("transfer(address,uint256)", router, uint256(250_000_000))
        );
    }

    function test_PolicyHashBindingRevertsOnMismatch() public {
        hook.assertPolicyHash(address(account), keccak256("agentproof/v1:test"));

        vm.expectRevert();
        hook.assertPolicyHash(address(account), keccak256("tampered"));
    }
}
