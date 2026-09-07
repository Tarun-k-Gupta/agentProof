// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IValidator, PackedUserOperation, MODULE_TYPE_VALIDATOR} from "erc7579/interfaces/IERC7579Module.sol";

/**
 * @notice Stands in for the agent's scoped session-key validator.
 *
 * @dev Accepts every signature on purpose. These tests are about what the
 *      *hook* does once a UserOperation has been validated — the interesting
 *      question is whether a validly-signed, over-limit operation is stopped,
 *      not whether an invalid signature is. Making the validator permissive is
 *      the stronger test: the agent's key is assumed to be working exactly as
 *      intended, and the boundary still holds.
 *
 *      Ours rather than the reference's MockValidator because that one lives in
 *      the lib's test tree and imports through the lib's own `src/` remapping,
 *      which collides with this project's `src`.
 */
contract MockSessionKeyValidator is IValidator {
    uint256 internal constant VALIDATION_SUCCESS = 0;

    function onInstall(bytes calldata) external override {}

    function onUninstall(bytes calldata) external override {}

    function validateUserOp(PackedUserOperation calldata, bytes32) external pure override returns (uint256) {
        return VALIDATION_SUCCESS;
    }

    function isValidSignatureWithSender(address, bytes32, bytes calldata) external pure override returns (bytes4) {
        return 0x1626ba7e;
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_VALIDATOR;
    }

    function isInitialized(address) external pure returns (bool) {
        return false;
    }
}
