// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPermissionedRegistry, IPermissionedResolver} from "./interfaces/IENSv2.sol";
import {
    ROLE_SET_SUBREGISTRY,
    ROLE_SET_SUBREGISTRY_ADMIN,
    ROLE_SET_RESOLVER,
    ROLE_SET_RESOLVER_ADMIN,
    ROLE_CAN_TRANSFER_ADMIN,
    ROLE_SET_ADDR_ADMIN,
    ROLE_SET_TEXT_ADMIN,
    COIN_TYPE_ETH
} from "./interfaces/IENSv2.sol";

/**
 * @title AgentSubnameRegistrar
 * @notice Mints one ENSv2 subname per protected agent in our namespace
 *         registry and wires record permissions that encode AgentProof's
 *         trust model:
 *
 *        holder                record                  meaning
 *        ─────────────────────────────────────────────────────────────────
 *        owner (human/Ledger)  agentproof.policy/hook  only a human can repoint the policy
 *        agent session key     agentproof.status       the agent may suspend itself…
 *                                                      …and can do nothing else
 *
 *      An agent can act inside its namespace but cannot rewrite the
 *      namespace's rules. That is the same asymmetry the on-chain hook
 *      enforces over funds, expressed over identity.
 *
 * @dev Canonical ENSv2 (Sepolia beta): names live in our UserRegistry proxy,
 *      records live on our PermissionedResolver proxy, and every permission
 *      is EAC-enforced there — not by modifiers here. The registrar is a
 *      thin, owner-gated gatekeeper in the tutorial pattern
 *      (docs.ens.domains/ensv2/tutorial-contract-developers).
 *
 *      `node` and `dnsName` are passed in from off-chain (cast namehash +
 *      DNS encoding) so the contract never parses names on-chain.
 */
contract AgentSubnameRegistrar {
    /// @dev Roles the agent-name owner receives (tutorial bitmap).
    uint256 public constant REGISTRATION_ROLE_BITMAP =
        ROLE_SET_SUBREGISTRY | ROLE_SET_SUBREGISTRY_ADMIN | ROLE_SET_RESOLVER | ROLE_SET_RESOLVER_ADMIN
            | ROLE_CAN_TRANSFER_ADMIN;

    /// @dev Admin bitmap the deployer grants this registrar on the agent's
    ///      node so it can delegate per-record roles.
    uint256 public constant NODE_ADMIN_BITMAP = ROLE_SET_TEXT_ADMIN | ROLE_SET_ADDR_ADMIN;

    /// @dev Text record keys. Aligned with ENSIP-26 agent record conventions.
    string public constant KEY_POLICY = "agentproof.policy";
    string public constant KEY_HOOK = "agentproof.hook";
    string public constant KEY_STATUS = "agentproof.status";

    IPermissionedRegistry public immutable registry;
    IPermissionedResolver public immutable resolver;
    address public owner;

    struct Agent {
        address account; // the agent's ERC-7579 smart account
        address sessionKey; // scoped key the agent process holds
        bytes32 policyHash; // keccak256 of the canonical policy JSON
        bytes32 node; // namehash of label.parent
        uint64 registeredAt;
    }

    mapping(string label => Agent) public agents;

    event AgentRegistered(string label, address indexed account, address indexed sessionKey, bytes32 policyHash);
    event PolicyRepointed(string label, bytes32 oldHash, bytes32 newHash);
    event AgentSuspended(string label);
    event OwnerTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotSessionKey();
    error LabelTaken(string label);
    error UnknownAgent(string label);
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IPermissionedRegistry _registry, IPermissionedResolver _resolver) {
        if (address(_registry) == address(0) || address(_resolver) == address(0)) revert ZeroAddress();
        registry = _registry;
        resolver = _resolver;
        owner = msg.sender;
    }

    /**
     * @notice Mint `label` in our namespace for an agent and wire its records
     *         and roles in one transaction.
     * @dev Requires the deployer to have granted this registrar
     *      NODE_ADMIN_BITMAP on the agent's node first (via authorizeNameRoles),
     *      plus REGISTRAR|RENEW on the namespace root. An agent cannot
     *      register itself, because self-registration is self-granted authority.
     */
    function registerAgent(
        string calldata label,
        bytes32 node,
        bytes calldata dnsName,
        address account,
        address sessionKey,
        bytes32 policyHash,
        address hook,
        uint64 duration
    ) external onlyOwner returns (uint256 tokenId) {
        if (agents[label].account != address(0)) revert LabelTaken(label);
        if (account == address(0) || sessionKey == address(0)) revert ZeroAddress();

        tokenId = registry.register(
            label, owner, address(0), address(resolver), REGISTRATION_ROLE_BITMAP, uint64(block.timestamp) + duration
        );

        // The asymmetry, enforced by the resolver's EAC.
        resolver.authorizeTextRoles(dnsName, KEY_POLICY, owner, true);
        resolver.authorizeTextRoles(dnsName, KEY_HOOK, owner, true);
        resolver.authorizeTextRoles(dnsName, KEY_STATUS, sessionKey, true);
        // The registrar keeps part-write so future repoints (owner) and
        // suspensions (session key, via suspend()) keep working. It holds no
        // ADMIN bits, so it cannot widen anyone's permissions — only write
        // the three parts above and the address.
        resolver.authorizeTextRoles(dnsName, KEY_POLICY, address(this), true);
        resolver.authorizeTextRoles(dnsName, KEY_HOOK, address(this), true);
        resolver.authorizeTextRoles(dnsName, KEY_STATUS, address(this), true);
        resolver.authorizeAddrRoles(dnsName, COIN_TYPE_ETH, address(this), true);

        resolver.setAddr(node, COIN_TYPE_ETH, abi.encodePacked(account));
        resolver.setText(node, KEY_POLICY, _toHexString(policyHash));
        resolver.setText(node, KEY_HOOK, _toHexString(uint256(uint160(hook)), 20));
        resolver.setText(node, KEY_STATUS, "active");

        agents[label] = Agent({
            account: account,
            sessionKey: sessionKey,
            policyHash: policyHash,
            node: node,
            registeredAt: uint64(block.timestamp)
        });

        emit AgentRegistered(label, account, sessionKey, policyHash);
    }

    /**
     * @notice Repoint an agent's policy record. Owner only.
     * @dev The demo's tamper scene calls this with the agent's key. It
     *      reverts here (NotOwner) — and a direct resolver.setText with the
     *      agent key reverts at the resolver's EAC check instead. The
     *      permission lives in ENS, not in a modifier we could forget.
     */
    function setPolicyHash(string calldata label, bytes32 newHash) external {
        Agent storage a = agents[label];
        if (a.account == address(0)) revert UnknownAgent(label);
        if (msg.sender != owner) revert NotOwner();

        resolver.setText(a.node, KEY_POLICY, _toHexString(newHash));

        bytes32 old = a.policyHash;
        a.policyHash = newHash;
        emit PolicyRepointed(label, old, newHash);
    }

    /**
     * @notice Suspend the agent. The session key — and only the session key
     *         besides the owner — may call this. It can halt itself; it
     *         cannot repoint policy, hook, or address records.
     */
    function suspend(string calldata label) external {
        Agent storage a = agents[label];
        if (a.account == address(0)) revert UnknownAgent(label);
        if (msg.sender != a.sessionKey && msg.sender != owner) revert NotSessionKey();

        resolver.setText(a.node, KEY_STATUS, "suspended");
        emit AgentSuspended(label);
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, next);
        owner = next;
    }

    // ---------------------------------------------------------------- helpers

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
