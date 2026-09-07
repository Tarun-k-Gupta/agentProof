// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @notice ERC-7579 Type 4 (hook) module interface.
 *
 * @dev This signature is not a matter of taste. ERC-7579 went through drafts in
 *      which `postCheck` took `(bytes hookData, bool success, bytes returnData)`;
 *      the final interface — and the reference implementation's HookManager,
 *      which is what an account actually calls — takes `(bytes hookData)` alone.
 *
 *          keccak("postCheck(bytes)")            → 0x173bf7da   ← accounts call this
 *          keccak("postCheck(bytes,bool,bytes)") → 0xaacbd72a   ← the draft
 *
 *      A hook implementing only the draft installs without complaint and then
 *      reverts on the account's very first execution, because `withHook` calls a
 *      selector the hook does not have. Nothing catches it except an account:
 *      a mock written against the same draft agrees with you perfectly.
 *
 *      Pinned against lib/erc7579-implementation (erc7579.com reference,
 *      v0.3.1), recorded in deployments/sepolia.json and exercised in
 *      test/integration/RealAccount.t.sol against MSAAdvanced through a real
 *      EntryPoint.
 */
interface IERC7579Hook {
    /// @return hookData opaque blob handed back to postCheck
    function preCheck(address msgSender, uint256 msgValue, bytes calldata msgData)
        external
        returns (bytes memory hookData);

    function postCheck(bytes calldata hookData) external;
}
