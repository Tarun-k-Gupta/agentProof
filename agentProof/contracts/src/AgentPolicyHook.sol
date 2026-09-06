// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";
import {IERC7579Hook} from "./interfaces/IERC7579Hook.sol";
import {PolicyLib} from "./lib/PolicyLib.sol";
import {ExecutionLib} from "./lib/ExecutionLib.sol";

/**
 * @title AgentPolicyHook
 * @notice ERC-7579 Type 4 hook enforcing AgentProof's critical policy subset
 *         inside a modular smart account's execution path.
 *
 * @dev Enforcement model
 *      preCheck  — reject unknown targets, snapshot the tracked asset balance,
 *                  return the snapshot as hookData.
 *      postCheck — measure the realised outflow (MEASURED provenance) and apply
 *                  PolicyLib.applySpend, which reverts if either formally
 *                  verified invariant would be broken.
 *
 *      The hook never trusts a declared amount. The only number it enforces on
 *      is the account's own balance delta across the execution.
 *
 *      Installed on the account, this is unbypassable short of uninstalling the
 *      module, which requires the owner validator — not the agent session key.
 */
contract AgentPolicyHook is IERC7579Hook {
    using PolicyLib for PolicyLib.Window;

    uint256 internal constant MODULE_TYPE_HOOK = 4;

    struct Config {
        address asset; // tracked ERC-20 (USDC on Sepolia)
        uint256 maxTransaction; // base units
        uint256 dailyLimit; // base units
        uint256 minBalance; // base units
        bytes32 policyHash; // keccak256 of the canonical policy JSON
        bool installed;
    }

    mapping(address account => Config) public config;
    mapping(address account => PolicyLib.Window) public window;
    mapping(address account => mapping(address target => bool)) public allowedTarget;

    event PolicyInstalled(address indexed account, bytes32 policyHash, address asset);
    event PolicyUninstalled(address indexed account);
    event SpendRecorded(address indexed account, address indexed target, uint256 amount, uint256 dayTotal, uint64 day);
    event TargetAllowed(address indexed account, address indexed target, bool allowed);

    error NotInstalled();
    error AlreadyInstalled();
    error TargetNotAllowed(address target);
    error BelowMinBalance(uint256 balance, uint256 minBalance);
    error UnsupportedCallType(bytes1 callType);
    error PolicyMismatch(bytes32 expected, bytes32 actual);

    // ---------------------------------------------------------------- module

    /// @param data abi.encode(Config, address[] allowedTargets)
    function onInstall(bytes calldata data) external {
        if (config[msg.sender].installed) revert AlreadyInstalled();

        (Config memory c, address[] memory targets) = abi.decode(data, (Config, address[]));
        c.installed = true;
        config[msg.sender] = c;

        for (uint256 i; i < targets.length; ++i) {
            allowedTarget[msg.sender][targets[i]] = true;
            emit TargetAllowed(msg.sender, targets[i], true);
        }
        emit PolicyInstalled(msg.sender, c.policyHash, c.asset);
    }

    function onUninstall(bytes calldata) external {
        delete config[msg.sender];
        delete window[msg.sender];
        emit PolicyUninstalled(msg.sender);
    }

    function isModuleType(uint256 t) external pure returns (bool) {
        return t == MODULE_TYPE_HOOK;
    }

    function isInitialized(address account) external view returns (bool) {
        return config[account].installed;
    }

    /// @notice Asserts the on-chain policy hash matches what the caller expects.
    /// @dev Used by the SDK at startup for the third leg of the ENS/file/chain
    ///      three-way binding. View-only, reverts loudly on divergence.
    function assertPolicyHash(address account, bytes32 expected) external view {
        bytes32 actual = config[account].policyHash;
        if (actual != expected) revert PolicyMismatch(expected, actual);
    }

    // ------------------------------------------------------------------ hook

    /// @inheritdoc IERC7579Hook
    function preCheck(address, uint256, bytes calldata msgData) external returns (bytes memory hookData) {
        Config memory c = config[msg.sender];
        if (!c.installed) revert NotInstalled();

        // Recover the ultimate call target from the 7579 execution payload.
        // Batch and delegatecall revert: see docs/threat-model.md "known gaps".
        (address target, bytes calldata innerCalldata) = ExecutionLib.decodeSingleExecution(msgData);
        if (!allowedTarget[msg.sender][target]) revert TargetNotAllowed(target);

        // A call to the tracked asset carries its counterparty inside calldata.
        // Checking it here is what makes the hook — not just the SDK — a defence
        // against prompt injection redirecting funds, and what closes the
        // "approve a non-allowlisted spender now, drain next block" hole.
        if (target == c.asset) {
            address counterparty = ExecutionLib.decodeErc20Counterparty(innerCalldata);
            if (counterparty != address(0) && !allowedTarget[msg.sender][counterparty]) {
                revert TargetNotAllowed(counterparty);
            }
        }

        uint256 balanceBefore = IERC20(c.asset).balanceOf(msg.sender);
        return abi.encode(balanceBefore, uint64(block.timestamp / 1 days), target);
    }

    /// @inheritdoc IERC7579Hook
    function postCheck(bytes calldata hookData, bool, bytes calldata) external {
        Config memory c = config[msg.sender];
        if (!c.installed) revert NotInstalled();

        (uint256 balanceBefore, uint64 today, address target) =
            abi.decode(hookData, (uint256, uint64, address));

        uint256 balanceAfter = IERC20(c.asset).balanceOf(msg.sender);
        uint256 outflow = balanceBefore > balanceAfter ? balanceBefore - balanceAfter : 0;

        if (outflow > 0) {
            // Reverts on MAX_TRANSFER or DAILY_SPEND violation.
            PolicyLib.Window memory next = PolicyLib.applySpend(
                window[msg.sender], PolicyLib.Limits(c.maxTransaction, c.dailyLimit), outflow, today
            );
            window[msg.sender] = next;
            emit SpendRecorded(msg.sender, target, outflow, next.spent, today);
        }

        if (balanceAfter < c.minBalance) revert BelowMinBalance(balanceAfter, c.minBalance);
    }

    // ------------------------------------------------------------------ views

    function remainingToday(address account) external view returns (uint256) {
        Config memory c = config[account];
        return PolicyLib.remainingToday(
            window[account], PolicyLib.Limits(c.maxTransaction, c.dailyLimit), uint64(block.timestamp / 1 days)
        );
    }
}
