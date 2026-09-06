// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @notice ERC-7579 Type 4 (hook) module interface.
 * @dev The preCheck/postCheck signatures changed during ERC-7579's life; older
 *      drafts had `postCheck(bytes)` only. Pin your account implementation and
 *      read its HookManager before installing. Verified against the account
 *      recorded in deployments/sepolia.json.
 */
interface IERC7579Hook {
    /// @return hookData opaque blob handed back to postCheck
    function preCheck(address msgSender, uint256 msgValue, bytes calldata msgData)
        external
        returns (bytes memory hookData);

    function postCheck(bytes calldata hookData, bool executionSuccess, bytes calldata executionReturnValue) external;
}
