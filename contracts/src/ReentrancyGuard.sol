// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Single-slot reentrancy lock. External calls happen after state updates.
abstract contract ReentrancyGuard {
    uint256 private constant UNLOCKED = 1;
    uint256 private constant LOCKED = 2;
    uint256 private _lock = UNLOCKED;

    error Reentered();

    modifier nonReentrant() {
        if (_lock != UNLOCKED) revert Reentered();
        _lock = LOCKED;
        _;
        _lock = UNLOCKED;
    }
}
