// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Roles} from "./Roles.sol";

/// @notice Single-chain model of lock-and-mint bridging.
/// @dev A message or a lock can be consumed once. Economic outstanding supply cannot exceed the cap.
contract SupplyLedger is Roles {
    uint256 public immutable cap;
    uint256 public circulating;
    uint256 public lockedOutstanding;
    mapping(bytes32 => uint256) public locks;
    mapping(bytes32 => bool) public lockUsed;
    mapping(bytes32 => bool) public messageUsed;

    error DoubleSupply();
    error Replay();
    error Overspend();

    constructor(address admin, uint256 cap_) {
        cap = cap_;
        _grant(DEFAULT_ADMIN, admin);
        _grant(BRIDGE, admin);
        _grant(MINTER, admin);
        _grant(PAUSER, admin);
    }

    function outstanding() public view returns (uint256) {
        return circulating + lockedOutstanding;
    }

    function mintNative(uint256 amount) external onlyRole(MINTER) onlyNonMainnet whenNotPaused {
        if (circulating + lockedOutstanding + amount > cap) revert DoubleSupply();
        circulating += amount;
    }

    function lockForBridge(bytes32 lockId, uint256 amount) external onlyRole(BRIDGE) whenNotPaused {
        if (locks[lockId] != 0 || lockUsed[lockId]) revert Replay();
        if (amount == 0 || amount > circulating) revert Overspend();
        circulating -= amount;
        lockedOutstanding += amount;
        locks[lockId] = amount;
    }

    function bridgeMint(bytes32 messageId, bytes32 lockId, uint256 amount) external onlyRole(BRIDGE) onlyNonMainnet whenNotPaused {
        if (messageUsed[messageId]) revert DoubleSupply();
        if (lockUsed[lockId] || locks[lockId] != amount || amount == 0) revert DoubleSupply();
        lockedOutstanding -= amount;
        if (circulating + lockedOutstanding + amount > cap) revert DoubleSupply();
        messageUsed[messageId] = true;
        lockUsed[lockId] = true;
        circulating += amount;
    }
}
