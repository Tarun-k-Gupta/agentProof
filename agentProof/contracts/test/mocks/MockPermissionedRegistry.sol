// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPermissionedRegistry, IEnhancedAccessControl, ROOT_RESOURCE} from "../../src/interfaces/IENSv2.sol";

/**
 * @notice A faithful-enough ENSv2 Permissioned Registry for testing the
 *         permission model AgentSubnameRegistrar relies on.
 *
 * @dev ENSv2 is in beta on Sepolia and its contracts are explicitly not final,
 *      so the integration cannot be pinned to a deployed address the way the
 *      7579 account is. What *can* be pinned is the property the integration
 *      claims: that Enhanced Access Control makes the agent's session key
 *      unable to widen its own policy while the owner's key can.
 *
 *      So this mock implements the one thing that property depends on — a role
 *      bitmap per (resource, account), checked on every authorised write — and
 *      nothing else. It deliberately does not model expiry, renewal, subname
 *      hierarchies or resolver indirection: a mock that reimplements the whole
 *      registry would be a second registry to get wrong.
 *
 *      Roles are per-resource. `ROOT_RESOURCE` governs minting; a name's own
 *      resource (its tokenId) governs its records. That split is what lets the
 *      registrar mint names it cannot subsequently rewrite.
 */
contract MockPermissionedRegistry is IPermissionedRegistry, IEnhancedAccessControl {
    struct Name {
        address owner;
        address resolver;
        address addr;
        uint64 expiry;
        bool registered;
    }

    mapping(uint256 tokenId => Name) public names;
    mapping(uint256 tokenId => mapping(string key => string value)) internal texts;
    mapping(bytes32 resource => mapping(address account => uint256 roles)) public roles;

    /// @dev Mirrors AgentSubnameRegistrar's constants; duplicated so a change
    ///      there has to be a deliberate change here too.
    uint256 public constant ROLE_REGISTRAR = 1 << 0;
    uint256 public constant ROLE_SET_POLICY_RECORD = 1 << 32;
    uint256 public constant ROLE_SET_STATUS_RECORD = 1 << 33;
    uint256 public constant ROLE_SET_HOOK_RECORD = 1 << 34;

    error Unauthorised(bytes32 resource, uint256 roleBitmap, address account);
    error LabelTaken(string label);

    event NameRegistered(uint256 indexed tokenId, string label, address owner);
    event TextChanged(uint256 indexed tokenId, string key, string value);

    constructor() {
        // Whoever deploys the registry bootstraps the root, and grants the
        // registrar its minting role from there.
        roles[ROOT_RESOURCE][msg.sender] = type(uint256).max;
    }

    // ------------------------------------------------------------- registry

    function register(string calldata label, address owner, address resolver, uint64 duration)
        external
        returns (uint256 tokenId)
    {
        if (!_has(ROOT_RESOURCE, ROLE_REGISTRAR, msg.sender)) {
            revert Unauthorised(ROOT_RESOURCE, ROLE_REGISTRAR, msg.sender);
        }

        tokenId = uint256(keccak256(bytes(label)));
        if (names[tokenId].registered) revert LabelTaken(label);

        names[tokenId] = Name({
            owner: owner,
            resolver: resolver,
            addr: address(0),
            expiry: uint64(block.timestamp) + duration,
            registered: true
        });

        emit NameRegistered(tokenId, label, owner);
    }

    function setAddr(uint256 tokenId, address a) external {
        names[tokenId].addr = a;
    }

    /**
     * @dev Unauthorised write path, used by the registrar during minting while
     *      it still holds the name. Records set here are the initial values;
     *      every later change has to go through {setTextAuthorised}.
     */
    function setText(uint256 tokenId, string calldata key, string calldata value) external {
        texts[tokenId][key] = value;
        emit TextChanged(tokenId, key, value);
    }

    /**
     * @dev The authorised write path. This is where the whole ENS integration
     *      earns its place: the permission is enforced by the registry against
     *      a role the caller either holds or does not, not by a modifier on our
     *      own contract that we could forget to add.
     */
    function setTextAuthorised(uint256 tokenId, string calldata key, string calldata value, address authorised)
        external
    {
        uint256 required = _roleForKey(key);
        bytes32 resource = bytes32(tokenId);
        if (!_has(resource, required, authorised)) revert Unauthorised(resource, required, authorised);

        texts[tokenId][key] = value;
        emit TextChanged(tokenId, key, value);
    }

    function text(uint256 tokenId, string calldata key) external view returns (string memory) {
        return texts[tokenId][key];
    }

    function addr(uint256 tokenId) external view returns (address) {
        return names[tokenId].addr;
    }

    // ------------------------------------------------- enhanced access control

    function grantRoles(bytes32 resource, uint256 roleBitmap, address account) external returns (bool) {
        roles[resource][account] |= roleBitmap;
        return true;
    }

    function revokeRoles(bytes32 resource, uint256 roleBitmap, address account) external returns (bool) {
        roles[resource][account] &= ~roleBitmap;
        return true;
    }

    function hasRoles(bytes32 resource, uint256 roleBitmap, address account) external view returns (bool) {
        return _has(resource, roleBitmap, account);
    }

    // ---------------------------------------------------------------- internals

    function _has(bytes32 resource, uint256 roleBitmap, address account) internal view returns (bool) {
        return roles[resource][account] & roleBitmap == roleBitmap;
    }

    function _roleForKey(string calldata key) internal pure returns (uint256) {
        bytes32 k = keccak256(bytes(key));
        if (k == keccak256("agentproof.policy")) return ROLE_SET_POLICY_RECORD;
        if (k == keccak256("agentproof.status")) return ROLE_SET_STATUS_RECORD;
        if (k == keccak256("agentproof.hook")) return ROLE_SET_HOOK_RECORD;
        // An unknown record key is not writable by anyone through this path.
        return type(uint256).max;
    }
}
