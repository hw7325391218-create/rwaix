// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Role split and a bounded pause. Pause cannot be open-ended.
abstract contract Roles {
    bytes32 public constant DEFAULT_ADMIN = keccak256("DEFAULT_ADMIN");
    bytes32 public constant PAUSER = keccak256("PAUSER");
    bytes32 public constant REGISTRAR = keccak256("REGISTRAR");
    bytes32 public constant MINTER = keccak256("MINTER");
    bytes32 public constant FEE_OPERATOR = keccak256("FEE_OPERATOR");
    bytes32 public constant BOND_LOCKER = keccak256("BOND_LOCKER");
    bytes32 public constant BOND_RELEASE = keccak256("BOND_RELEASE");
    bytes32 public constant SLASHER = keccak256("SLASHER");
    bytes32 public constant REWARD_APPROVER = keccak256("REWARD_APPROVER");
    bytes32 public constant BRIDGE = keccak256("BRIDGE");
    bytes32 public constant STATUS_ADMIN = keccak256("STATUS_ADMIN");

    mapping(bytes32 => mapping(address => bool)) public hasRole;
    uint64 public constant MAX_PAUSE = 7 days;
    uint64 public pausedUntil;

    error Unauthorized(bytes32 role);
    error Paused();
    error PauseDuration();
    error MainnetForbidden();
    error ZeroAddress();

    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

    modifier onlyRole(bytes32 role) {
        if (!hasRole[role][msg.sender]) revert Unauthorized(role);
        _;
    }

    modifier whenNotPaused() {
        if (block.timestamp < pausedUntil) revert Paused();
        _;
    }

    modifier onlyNonMainnet() {
        if (block.chainid == 1) revert MainnetForbidden();
        _;
    }

    function _grant(bytes32 role, address account) internal {
        if (account == address(0)) revert ZeroAddress();
        hasRole[role][account] = true;
        emit RoleGranted(role, account, msg.sender);
    }

    function grantRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN) {
        _grant(role, account);
    }

    /// @notice Removes a role. The caller cannot drop their own admin role.
    function revokeRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN) {
        if (role == DEFAULT_ADMIN && account == msg.sender) revert Unauthorized(role);
        hasRole[role][account] = false;
        emit RoleRevoked(role, account, msg.sender);
    }

    function pause(uint64 duration) external onlyRole(PAUSER) {
        if (duration == 0 || duration > MAX_PAUSE) revert PauseDuration();
        pausedUntil = uint64(block.timestamp) + duration;
    }

    /// @notice Emergency halt for the maximum bounded duration. It does not extend past MAX_PAUSE.
    function emergencyPause() external onlyRole(PAUSER) {
        pausedUntil = uint64(block.timestamp) + MAX_PAUSE;
    }

    function unpause() external onlyRole(PAUSER) {
        pausedUntil = 0;
    }
}
