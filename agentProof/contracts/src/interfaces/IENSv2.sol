// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @notice The subset of the ENSv2 Permissioned Registry / Resolver surface that
 *         AgentSubnameRegistrar depends on.
 *
 * @dev ENSv2 is in beta on Sepolia and the ABI is explicitly not final. We pin
 *      a narrow interface here rather than importing the upstream package so a
 *      breaking upstream change is a one-file fix, and record the exact
 *      deployed addresses in deployments/ensv2-sepolia.json.
 */
interface IPermissionedRegistry {
    function register(string calldata label, address owner, address resolver, uint64 duration)
        external
        returns (uint256 tokenId);

    function setAddr(uint256 tokenId, address addr) external;

    function setText(uint256 tokenId, string calldata key, string calldata value) external;

    /// @dev Applies the caller's EAC roles for `authorised` before writing.
    function setTextAuthorised(uint256 tokenId, string calldata key, string calldata value, address authorised) external;

    function text(uint256 tokenId, string calldata key) external view returns (string memory);

    function addr(uint256 tokenId) external view returns (address);
}

bytes32 constant ROOT_RESOURCE = bytes32(0);

interface IEnhancedAccessControl {
    function grantRoles(bytes32 resource, uint256 roleBitmap, address account) external returns (bool);

    function revokeRoles(bytes32 resource, uint256 roleBitmap, address account) external returns (bool);

    function hasRoles(bytes32 resource, uint256 roleBitmap, address account) external view returns (bool);
}
