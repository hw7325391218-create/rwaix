// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Roles} from "./Roles.sol";

/// @notice Performance bond. Locking does not prove a fact. Slash and release are different roles.
contract BondModule is Roles {
    enum State {
        None,
        Locked,
        Released,
        Slashed
    }

    struct Bond {
        address subject;
        bytes32 assetId;
        uint256 amount;
        State state;
    }

    mapping(bytes32 => Bond) public bonds;

    error NotFound();
    error StateConflict();

    event BondLocked(bytes32 indexed bondId, uint256 amount);
    event BondReleased(bytes32 indexed bondId);
    event BondSlashed(bytes32 indexed bondId);

    constructor(address admin) {
        _grant(DEFAULT_ADMIN, admin);
        _grant(BOND_LOCKER, admin);
        _grant(PAUSER, admin);
    }

    function lock(bytes32 bondId, address subject, bytes32 assetId, uint256 amount) external onlyRole(BOND_LOCKER) whenNotPaused {
        if (bonds[bondId].state != State.None) revert StateConflict();
        bonds[bondId] = Bond(subject, assetId, amount, State.Locked);
        emit BondLocked(bondId, amount);
    }

    function release(bytes32 bondId) external onlyRole(BOND_RELEASE) whenNotPaused {
        Bond storage bond = bonds[bondId];
        if (bond.state != State.Locked) revert StateConflict();
        bond.state = State.Released;
        emit BondReleased(bondId);
    }

    function slash(bytes32 bondId) external onlyRole(SLASHER) whenNotPaused {
        Bond storage bond = bonds[bondId];
        if (bond.state != State.Locked) revert NotFound();
        bond.state = State.Slashed;
        emit BondSlashed(bondId);
    }
}
