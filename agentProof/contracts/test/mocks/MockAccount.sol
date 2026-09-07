// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC7579Hook} from "../../src/interfaces/IERC7579Hook.sol";

/**
 * @notice Minimal ERC-7579-shaped account: enough HookManager behaviour to test
 *         the hook honestly, and nothing more.
 *
 * @dev The real deployment installs the hook on a pinned production account
 *      implementation (see deployments/sepolia.json). This mock exists so the
 *      unit tests exercise the hook's own logic without dragging an entire
 *      4337 stack into every test run. The integration suite under
 *      test/integration/ uses the real account.
 */
contract MockAccount {
    bytes4 internal constant EXECUTE_SELECTOR = 0xe9ae5c53; // execute(bytes32,bytes)
    bytes32 internal constant MODE_SINGLE = bytes32(0);

    address public hook;

    function installHook(address _hook, bytes calldata data) external {
        hook = _hook;
        (bool ok, bytes memory err) = _hook.call(abi.encodeWithSignature("onInstall(bytes)", data));
        if (!ok) _bubbleRevert(err);
    }

    /// @notice The ERC-7579 execution path: preCheck → call → postCheck.
    function rawExecute(address _hook, address target, bytes memory callData) public {
        bytes memory executionCalldata = abi.encodePacked(target, uint256(0), callData);
        bytes memory msgData = abi.encodeWithSelector(EXECUTE_SELECTOR, MODE_SINGLE, executionCalldata);

        bytes memory hookData = IERC7579Hook(_hook).preCheck(msg.sender, 0, msgData);

        (bool ok, bytes memory ret) = target.call(callData);
        if (!ok) _bubbleRevert(ret);

        IERC7579Hook(_hook).postCheck(hookData);
    }

    /// @notice Convenience: move `amount` of `asset` to `target`.
    function spend(address _hook, address asset, address target, uint256 amount) external {
        // The 7579 target of an ERC-20 move is the token contract; the
        // recipient lives in calldata and is checked as the counterparty.
        rawExecute(_hook, asset, abi.encodeWithSignature("transfer(address,uint256)", target, amount));
    }

    /// @notice Moves `actual` while the calldata claims `declared` (threat T4).
    function spendDeclaringLess(address _hook, address asset, address target, uint256 actual, uint256 declared)
        external
    {
        declared; // deliberately unused: the hook never reads it
        rawExecute(_hook, asset, abi.encodeWithSignature("transfer(address,uint256)", target, actual));
    }

    /**
     * @dev Re-raises a failed call's revert data unchanged, so a test can assert
     *      on the hook's own custom errors rather than on a string this mock
     *      invented.
     *
     *      Written as a statement rather than as `require(ok, _reason(ret))`,
     *      which is how it started. Solidity evaluates a require's second
     *      argument before it evaluates the condition, so that version raised
     *      the *successful* return data as a revert on every passing call —
     *      ERC-20 `transfer` returns `true`, 32 non-empty bytes, and every test
     *      in this file failed with an unreadable empty error.
     */
    function _bubbleRevert(bytes memory ret) internal pure {
        if (ret.length == 0) revert("MockAccount: call failed");
        assembly {
            revert(add(ret, 32), mload(ret))
        }
    }
}
