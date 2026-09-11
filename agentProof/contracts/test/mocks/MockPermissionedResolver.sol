// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPermissionedResolver} from "../../src/interfaces/IENSv2.sol";

/**
 * @notice Canonical-shaped ENSv2 Permissioned Resolver for testing.
 *
 * @dev Mirrors the real EAC model: per-(name, record) part resources,
 *      ADMIN-gated delegation via authorize*Roles, role-gated setText/setAddr.
 *      Resource math copies PermissionedResolverLib exactly
 *      (resource = keccak(node, part); text parts = keccak(key)).
 *      Role values copy the canonical nybbles (SET_ADDR = 1<<0,
 *      SET_TEXT = 1<<4, ADMIN variants shifted 128).
 */
contract MockPermissionedResolver is IPermissionedResolver {
    uint256 internal constant SET_ADDR = 1 << 0;
    uint256 internal constant SET_ADDR_ADMIN = SET_ADDR << 128;
    uint256 internal constant SET_TEXT = 1 << 4;
    uint256 internal constant SET_TEXT_ADMIN = SET_TEXT << 128;

    mapping(uint256 resource => mapping(address account => uint256 roles)) public roles;
    mapping(bytes32 node => mapping(string key => string value)) internal texts;
    mapping(bytes32 node => mapping(uint256 coinType => bytes value)) internal addrs;

    address public immutable admin;

    error Unauthorised(address account);

    constructor() {
        admin = msg.sender;
        roles[0][msg.sender] = type(uint256).max;
    }

    function authorizeNameRoles(bytes calldata toName, uint256 roleBitmap, address account, bool grant)
        external
        returns (bool)
    {
        if (msg.sender != admin) revert Unauthorised(msg.sender);
        uint256 resource = _nodeResource(keccak256(toName));
        if (grant) roles[resource][account] |= roleBitmap;
        else roles[resource][account] &= ~roleBitmap;
        return true;
    }

    function authorizeTextRoles(bytes calldata toName, string calldata key, address account, bool grant)
        external
        returns (bool)
    {
        bytes32 node = keccak256(toName);
        if (!_has(_nodeResource(node), SET_TEXT_ADMIN, msg.sender)) revert Unauthorised(msg.sender);
        uint256 part = _part(node, keccak256(bytes(key)));
        if (grant) roles[part][account] |= SET_TEXT;
        else roles[part][account] &= ~SET_TEXT;
        return true;
    }

    function authorizeAddrRoles(bytes calldata toName, uint256 coinType, address account, bool grant)
        external
        returns (bool)
    {
        bytes32 node = keccak256(toName);
        if (!_has(_nodeResource(node), SET_ADDR_ADMIN, msg.sender)) revert Unauthorised(msg.sender);
        uint256 part = _part(node, keccak256(abi.encode(coinType)));
        if (grant) roles[part][account] |= SET_ADDR;
        else roles[part][account] &= ~SET_ADDR;
        return true;
    }

    function setText(bytes32 node, string calldata key, string calldata value) external {
        if (!_has(_part(node, keccak256(bytes(key))), SET_TEXT, msg.sender)) revert Unauthorised(msg.sender);
        texts[node][key] = value;
    }

    function setAddr(bytes32 node, uint256 coinType, bytes calldata addressBytes) external {
        if (!_has(_part(node, keccak256(abi.encode(coinType))), SET_ADDR, msg.sender)) {
            revert Unauthorised(msg.sender);
        }
        addrs[node][coinType] = addressBytes;
    }

    function text(bytes32 node, string calldata key) external view returns (string memory) {
        return texts[node][key];
    }

    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory) {
        return addrs[node][coinType];
    }

    function _nodeResource(bytes32 node) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(node, bytes32(0))));
    }

    function _part(bytes32 node, bytes32 partHash) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(node, partHash)));
    }

    function _has(uint256 resource, uint256 roleBitmap, address account) internal view returns (bool) {
        return roles[resource][account] & roleBitmap == roleBitmap;
    }
}
