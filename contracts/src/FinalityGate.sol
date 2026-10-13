// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Roles} from "./Roles.sol";

/// @notice Included is not final. A reorg sends the operation back to re-check.
contract FinalityGate is Roles {
    enum Inclusion {
        None,
        Submitted,
        Included,
        Final,
        Reorged
    }

    mapping(bytes32 => Inclusion) public inclusion;

    error FinalityNotReached();
    error Reorged();

    event InclusionSet(bytes32 indexed op, Inclusion state);

    constructor(address admin) {
        _grant(DEFAULT_ADMIN, admin);
        _grant(STATUS_ADMIN, admin);
    }

    function setInclusion(bytes32 op, Inclusion state) external onlyRole(STATUS_ADMIN) {
        inclusion[op] = state;
        emit InclusionSet(op, state);
    }

    function consume(bytes32 op) external view returns (bool) {
        Inclusion state = inclusion[op];
        if (state == Inclusion.Reorged) revert Reorged();
        if (state != Inclusion.Final) revert FinalityNotReached();
        return true;
    }
}
