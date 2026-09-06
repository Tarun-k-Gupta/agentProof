// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPermissionedRegistry, IEnhancedAccessControl} from "./interfaces/IENSv2.sol";

/**
 * @title AgentSubnameRegistrar
 * @notice Mints one ENSv2 subname per protected agent under `agentproof.eth`
 *         and grants Enhanced Access Control roles that encode AgentProof's
 *         trust model directly in the namespace.
 *
 * @dev The whole thesis, expressed as ENS permissions:
 *
 *        holder                role                     resource            meaning
 *        ─────────────────────────────────────────────────────────────────────────
 *        owner (human/Ledger)  ROLE_SET_POLICY_RECORD   agent's name        only a human can repoint the policy
 *        agent session key     ROLE_SET_STATUS_RECORD   agent's name        the agent may suspend itself…
 *                                                                           …and can do nothing else
 *        this registrar        ROLE_REGISTRAR|ROLE_RENEW ROOT_RESOURCE      may mint and renew agent subnames
 *
 *      An agent can act inside its namespace but cannot rewrite the
 *      namespace's rules. That is the same asymmetry the on-chain hook
 *      enforces over funds, expressed over identity.
 *
 *      ENSv2 contracts are beta and not final. Exact addresses used are pinned
 *      in deployments/ensv2-sepolia.json.
 */
contract AgentSubnameRegistrar {
    /// @dev ENSv2 root-resource role bitmap positions.
    uint256 public constant ROLE_REGISTRAR = 1 << 0;
    uint256 public constant ROLE_RENEW = 1 << 16;

    /// @dev Per-name resource roles minted by this registrar.
    uint256 public constant ROLE_SET_POLICY_RECORD = 1 << 32;
    uint256 public constant ROLE_SET_STATUS_RECORD = 1 << 33;
    uint256 public constant ROLE_SET_HOOK_RECORD = 1 << 34;

    /// @dev Text record keys. Aligned with ENSIP-26 agent record conventions.
    string public constant KEY_POLICY = "agentproof.policy";
    string public constant KEY_HOOK = "agentproof.hook";
    string public constant KEY_STATUS = "agentproof.status";

    IPermissionedRegistry public immutable registry;
    address public immutable resolver;
    address public owner;

    struct Agent {
        address account; // the agent's ERC-7579 smart account
        address sessionKey; // scoped key the agent process holds
        bytes32 policyHash; // keccak256 of the canonical policy JSON
        uint64 registeredAt;
    }

    mapping(string label => Agent) public agents;

    event AgentRegistered(string label, address indexed account, address indexed sessionKey, bytes32 policyHash);
    event PolicyRepointed(string label, bytes32 oldHash, bytes32 newHash);
    event OwnerTransferred(address indexed from, address indexed to);

    error NotOwner();
    error LabelTaken(string label);
    error UnknownAgent(string label);
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IPermissionedRegistry _registry, address _resolver) {
        if (address(_registry) == address(0) || _resolver == address(0)) revert ZeroAddress();
        registry = _registry;
        resolver = _resolver;
        owner = msg.sender;
    }

    /**
     * @notice Mint `label.agentproof.eth` for an agent and wire up its records
     *         and roles in one transaction.
     * @dev Deliberately owner-gated. An agent cannot register itself, because
     *      self-registration is self-granted authority.
     */
    function registerAgent(
        string calldata label,
        address account,
        address sessionKey,
        bytes32 policyHash,
        address hook,
        uint64 duration
    ) external onlyOwner returns (uint256 tokenId) {
        if (agents[label].account != address(0)) revert LabelTaken(label);
        if (account == address(0) || sessionKey == address(0)) revert ZeroAddress();

        // Mint the subname. The registrar holds ROLE_REGISTRAR on ROOT_RESOURCE.
        tokenId = registry.register(label, owner, resolver, duration);

        bytes32 resource = _resource(tokenId);

        registry.setAddr(tokenId, account);
        registry.setText(tokenId, KEY_POLICY, _toHexString(policyHash));
        registry.setText(tokenId, KEY_HOOK, _toHexString(uint256(uint160(hook)), 20));
        registry.setText(tokenId, KEY_STATUS, "active");

        // The asymmetry. Owner may repoint the policy; the agent may only
        // suspend itself. Neither role is grantable by its holder.
        IEnhancedAccessControl(address(registry)).grantRoles(resource, ROLE_SET_POLICY_RECORD, owner);
        IEnhancedAccessControl(address(registry)).grantRoles(resource, ROLE_SET_HOOK_RECORD, owner);
        IEnhancedAccessControl(address(registry)).grantRoles(resource, ROLE_SET_STATUS_RECORD, sessionKey);

        agents[label] = Agent({
            account: account,
            sessionKey: sessionKey,
            policyHash: policyHash,
            registeredAt: uint64(block.timestamp)
        });

        emit AgentRegistered(label, account, sessionKey, policyHash);
    }

    /**
     * @notice Repoint an agent's policy record. Owner only.
     * @dev This is the function the demo's tamper scene calls with the agent's
     *      key. It reverts at the EAC check inside the registry, not here —
     *      the permission lives in ENS, not in a modifier we could forget.
     */
    function setPolicyHash(string calldata label, uint256 tokenId, bytes32 newHash) external {
        Agent storage a = agents[label];
        if (a.account == address(0)) revert UnknownAgent(label);

        // Reverts unless msg.sender holds ROLE_SET_POLICY_RECORD on this name.
        registry.setTextAuthorised(tokenId, KEY_POLICY, _toHexString(newHash), msg.sender);

        bytes32 old = a.policyHash;
        a.policyHash = newHash;
        emit PolicyRepointed(label, old, newHash);
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, next);
        owner = next;
    }

    // ---------------------------------------------------------------- helpers

    function _resource(uint256 tokenId) internal pure returns (bytes32) {
        return bytes32(tokenId);
    }

    function _toHexString(bytes32 value) internal pure returns (string memory) {
        return _toHexString(uint256(value), 32);
    }

    function _toHexString(uint256 value, uint256 length) internal pure returns (string memory) {
        bytes memory buffer = new bytes(2 * length + 2);
        buffer[0] = "0";
        buffer[1] = "x";
        for (uint256 i = 2 * length + 1; i > 1; --i) {
            uint8 nibble = uint8(value & 0xf);
            buffer[i] = nibble < 10 ? bytes1(nibble + 48) : bytes1(nibble + 87);
            value >>= 4;
        }
        return string(buffer);
    }
}
