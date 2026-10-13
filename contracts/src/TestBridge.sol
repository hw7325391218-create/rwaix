// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuard} from "./ReentrancyGuard.sol";
import {Roles} from "./Roles.sol";
import {RwaixTestToken} from "./RwaixTestToken.sol";

interface ITransferFrom {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Local lock side of a two-chain test bridge. Not a production bridge.
contract Lockbox is Roles, ReentrancyGuard {
    ITransferFrom public immutable token;
    uint256 public locked;
    mapping(bytes32 => uint256) public locks;

    event Locked(bytes32 indexed lockId, address indexed recipient, uint256 amount, uint256 destChainId);

    error Replay();
    error Zero();

    constructor(address admin, address token_) {
        if (block.chainid == 1) revert MainnetForbidden();
        if (token_ == address(0)) revert Zero();
        token = ITransferFrom(token_);
        _grant(DEFAULT_ADMIN, admin);
        _grant(PAUSER, admin);
    }

    function lock(bytes32 lockId, address recipient, uint256 amount, uint256 destChainId) external nonReentrant whenNotPaused {
        if (amount == 0) revert Zero();
        if (recipient == address(0)) revert Zero();
        if (locks[lockId] != 0) revert Replay();
        locks[lockId] = amount;
        locked += amount;
        require(token.transferFrom(msg.sender, address(this), amount), "transfer failed");
        emit Locked(lockId, recipient, amount, destChainId);
    }
}

/// @notice Local mint side. A message id can be relayed once. Supply is the sum of accepted messages.
contract RemoteMint is Roles, ReentrancyGuard {
    RwaixTestToken public immutable token;
    uint256 public minted;
    mapping(bytes32 => bool) public seen;

    error Replay();
    error Zero();

    constructor(address admin, RwaixTestToken token_) {
        if (block.chainid == 1) revert MainnetForbidden();
        token = token_;
        _grant(DEFAULT_ADMIN, admin);
        _grant(PAUSER, admin);
        _grant(BRIDGE, admin);
    }

    function relay(uint256 sourceChainId, bytes32 lockId, address recipient, uint256 amount)
        external
        nonReentrant
        onlyRole(BRIDGE)
        whenNotPaused
        onlyNonMainnet
    {
        if (amount == 0 || recipient == address(0)) revert Zero();
        bytes32 id = keccak256(abi.encode(sourceChainId, lockId, recipient, amount));
        if (seen[id]) revert Replay();
        seen[id] = true;
        minted += amount;
        token.mint(recipient, amount);
    }
}
