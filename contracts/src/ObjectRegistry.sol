// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Roles} from "./Roles.sol";

/// @notice Object identity and lifecycle. Verification does not read token balances.
contract ObjectRegistry is Roles {
    enum Lifecycle {
        None,
        Draft,
        Active,
        Suspended,
        Revoked,
        Retired
    }

    struct Object {
        Lifecycle state;
        uint64 version;
        address controller;
    }

    mapping(bytes32 => Object) public objects;
    mapping(bytes32 => mapping(uint64 => bytes32)) public versionDigest;

    error BadTransition(Lifecycle from, Lifecycle to);
    error VersionConflict();
    error UnknownObject();

    event ObjectRegistered(bytes32 indexed id, address controller);
    event VersionPublished(bytes32 indexed id, uint64 version, bytes32 digest);
    event LifecycleChanged(bytes32 indexed id, Lifecycle state);

    constructor(address admin) {
        _grant(DEFAULT_ADMIN, admin);
        _grant(REGISTRAR, admin);
        _grant(STATUS_ADMIN, admin);
        _grant(PAUSER, admin);
    }

    /// @dev Any account may register an object it controls. No DCNFT or $RWAIX balance is read.
    function register(bytes32 id, address controller) external whenNotPaused {
        if (objects[id].state != Lifecycle.None) revert VersionConflict();
        if (controller != msg.sender && !hasRole[REGISTRAR][msg.sender]) revert Unauthorized(REGISTRAR);
        objects[id] = Object(Lifecycle.Draft, 0, controller);
        emit ObjectRegistered(id, controller);
    }

    function publish(bytes32 id, uint64 version, bytes32 digest) external whenNotPaused {
        Object storage obj = objects[id];
        if (obj.state == Lifecycle.None) revert UnknownObject();
        if (msg.sender != obj.controller && !hasRole[REGISTRAR][msg.sender]) revert Unauthorized(REGISTRAR);
        if (obj.state == Lifecycle.Revoked || obj.state == Lifecycle.Retired) revert BadTransition(obj.state, obj.state);
        if (version != obj.version + 1 || versionDigest[id][version] != bytes32(0)) revert VersionConflict();
        versionDigest[id][version] = digest;
        obj.version = version;
        if (obj.state == Lifecycle.Draft) {
            obj.state = Lifecycle.Active;
            emit LifecycleChanged(id, Lifecycle.Active);
        }
        emit VersionPublished(id, version, digest);
    }

    function transition(bytes32 id, Lifecycle to) external whenNotPaused {
        Object storage obj = objects[id];
        if (obj.state == Lifecycle.None) revert UnknownObject();
        if (to == Lifecycle.Revoked && !hasRole[STATUS_ADMIN][msg.sender]) revert Unauthorized(STATUS_ADMIN);
        if (msg.sender != obj.controller && !hasRole[STATUS_ADMIN][msg.sender] && !hasRole[REGISTRAR][msg.sender]) {
            revert Unauthorized(STATUS_ADMIN);
        }
        if (!_allowed(obj.state, to)) revert BadTransition(obj.state, to);
        obj.state = to;
        emit LifecycleChanged(id, to);
    }

    /// @notice Open verification path. Token holdings are irrelevant.
    function verificationOpen(address) external pure returns (bool) {
        return true;
    }

    function _allowed(Lifecycle from, Lifecycle to) internal pure returns (bool) {
        if (from == Lifecycle.Draft) return to == Lifecycle.Active || to == Lifecycle.Retired;
        if (from == Lifecycle.Active) return to == Lifecycle.Suspended || to == Lifecycle.Revoked || to == Lifecycle.Retired;
        if (from == Lifecycle.Suspended) return to == Lifecycle.Active || to == Lifecycle.Revoked || to == Lifecycle.Retired;
        return false;
    }
}
