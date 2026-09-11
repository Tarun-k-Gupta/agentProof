// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPermissionedRegistry} from "../../src/interfaces/IENSv2.sol";

/**
 * @notice Canonical-shaped ENSv2 Permissioned Registry for testing the
 *         permission model AgentSubnameRegistrar relies on.
 *
 * @dev Mirrors the real contracts' enforcement points — 6-arg register gated
 *      by REGISTRAR on root, renew, grantRootRoles, and uint256 resources —
 *      and nothing else. No expiry, no hierarchies, no token versioning: a
 *      mock that reimplements the whole registry would be a second registry
 *      to get wrong. The live Sepolia deployment is the integration proof.
 */
contract MockPermissionedRegistry is IPermissionedRegistry {
    uint256 public constant ROLE_REGISTRAR = 1 << 0;
    uint256 public constant ROLE_RENEW = 1 << 16;

    mapping(uint256 resource => mapping(address account => uint256 roles)) public roles;
    mapping(uint256 labelId => bool) public registered;

    error Unauthorised(uint256 resource, uint256 roleBitmap, address account);
    error LabelTaken(string label);

    event NameRegistered(uint256 indexed tokenId, string label, address owner);

    constructor() {
        roles[0][msg.sender] = type(uint256).max;
    }

    function register(
        string calldata label,
        address owner,
        address,
        address,
        uint256,
        uint64
    ) external returns (uint256 tokenId) {
        if (!_has(0, ROLE_REGISTRAR, msg.sender)) revert Unauthorised(0, ROLE_REGISTRAR, msg.sender);
        tokenId = uint256(keccak256(bytes(label)));
        if (registered[tokenId]) revert LabelTaken(label);
        registered[tokenId] = true;
        emit NameRegistered(tokenId, label, owner);
    }

    function renew(uint256, uint64) external {}

    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool) {
        roles[0][account] |= roleBitmap;
        return true;
    }

    function hasRoles(uint256 resource, uint256 roleBitmap, address account) external view returns (bool) {
        return _has(resource, roleBitmap, account);
    }

    function _has(uint256 resource, uint256 roleBitmap, address account) internal view returns (bool) {
        return roles[resource][account] & roleBitmap == roleBitmap;
    }
}
