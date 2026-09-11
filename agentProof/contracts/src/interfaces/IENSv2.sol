// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @notice The subset of the canonical ENSv2 (Sepolia beta) surface that
 *         AgentSubnameRegistrar depends on.
 *
 * @dev Canonical signatures, verified against ensdomains/contracts-v2:
 *      PermissionedRegistry.register(string,address,IRegistry,address,uint256,uint64),
 *      EnhancedAccessControl.grantRoles(uint256,uint256,address), and the
 *      PermissionedResolver authorize and setter family. An earlier revision of
 *      this file targeted a pre-final beta ABI (4-arg register, bytes32
 *      resources, registry-held records); v2 stores records on the resolver
 *      and versions every resource, so the registrar was rewritten with it.
 *      Role constants mirror RegistryRolesLib / PermissionedResolverLib.
 */
interface IPermissionedRegistry {
    function register(
        string calldata label,
        address owner,
        address subregistry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256 tokenId);

    function renew(uint256 anyId, uint64 newExpiry) external;

    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);

    function hasRoles(uint256 anyId, uint256 roleBitmap, address account) external view returns (bool);
}

interface IPermissionedResolver {
    function authorizeNameRoles(bytes calldata toName, uint256 roleBitmap, address account, bool grant)
        external
        returns (bool);

    function authorizeTextRoles(bytes calldata toName, string calldata key, address account, bool grant)
        external
        returns (bool);

    function authorizeAddrRoles(bytes calldata toName, uint256 coinType, address account, bool grant)
        external
        returns (bool);

    function setText(bytes32 node, string calldata key, string calldata value) external;

    function setAddr(bytes32 node, uint256 coinType, bytes calldata addressBytes) external;

    function text(bytes32 node, string calldata key) external view returns (string memory);

    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory);
}

// Canonical RegistryRolesLib (root positions).
uint256 constant ROLE_REGISTRAR = 1 << 0;
uint256 constant ROLE_RENEW = 1 << 16;
uint256 constant ROLE_SET_SUBREGISTRY = 1 << 20;
uint256 constant ROLE_SET_SUBREGISTRY_ADMIN = ROLE_SET_SUBREGISTRY << 128;
uint256 constant ROLE_SET_RESOLVER = 1 << 24;
uint256 constant ROLE_SET_RESOLVER_ADMIN = ROLE_SET_RESOLVER << 128;
uint256 constant ROLE_CAN_TRANSFER_ADMIN = (1 << 28) << 128;

// Canonical PermissionedResolverLib.
uint256 constant ROLE_SET_ADDR = 1 << 0;
uint256 constant ROLE_SET_ADDR_ADMIN = ROLE_SET_ADDR << 128;
uint256 constant ROLE_SET_TEXT = 1 << 4;
uint256 constant ROLE_SET_TEXT_ADMIN = ROLE_SET_TEXT << 128;

uint256 constant COIN_TYPE_ETH = 60;
