// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Roles} from "./Roles.sol";

interface IDecimals {
    function decimals() external view returns (uint8);
}

/// @notice Binds an asset id to one chain-local contract and one decimals value.
contract TokenRegistry is Roles {
    struct Asset {
        address token;
        uint8 decimals;
        bool exists;
    }

    mapping(bytes32 => Asset) public assets;

    error AssetMismatch();
    error DecimalsMismatch();

    constructor(address admin) {
        _grant(DEFAULT_ADMIN, admin);
        _grant(REGISTRAR, admin);
    }

    function register(bytes32 assetId, address token, uint8 decimals_) external onlyRole(REGISTRAR) {
        if (token.code.length > 0) {
            try IDecimals(token).decimals() returns (uint8 onchain) {
                if (onchain != decimals_) revert DecimalsMismatch();
            } catch {}
        }
        Asset memory current = assets[assetId];
        if (current.exists) {
            if (current.token != token || current.decimals != decimals_) revert AssetMismatch();
            return;
        }
        assets[assetId] = Asset(token, decimals_, true);
    }

    function get(bytes32 assetId) external view returns (Asset memory) {
        return assets[assetId];
    }
}
