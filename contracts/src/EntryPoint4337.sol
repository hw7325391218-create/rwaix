// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Local ERC-4337-shaped entrypoint and account.
/// @dev This is not the canonical EntryPoint and it is not a public bundler.
///      It checks nonce, expiry, scope, and the account signature, then executes.
contract EntryPoint4337 {
    struct UserOperation {
        address sender;
        uint256 nonce;
        bytes callData;
        uint64 validUntil;
        bytes32 scopeHash;
        bytes signature;
    }

    mapping(address => uint256) public nonces;

    error BadNonce();
    error CallFailed();

    function getUserOpHash(UserOperation calldata op) public view returns (bytes32) {
        return keccak256(abi.encode(op.sender, op.nonce, keccak256(op.callData), op.validUntil, op.scopeHash, block.chainid, address(this)));
    }

    function handleOp(UserOperation calldata op) external {
        if (op.nonce != nonces[op.sender]) revert BadNonce();
        SimpleAccount(payable(op.sender)).validateUserOp(op, getUserOpHash(op));
        nonces[op.sender] = op.nonce + 1;
        (bool ok,) = op.sender.call(op.callData);
        if (!ok) revert CallFailed();
    }
}

contract SimpleAccount {
    address public immutable owner;
    address public immutable sessionKey;
    uint64 public immutable sessionExpiry;
    bytes32 public immutable sessionScope;
    address public immutable entryPoint;

    error Unauthorized();
    error Expired();
    error Scope();
    error CallFailed();
    error ZeroAddress();

    constructor(address owner_, address entryPoint_, address sessionKey_, uint64 sessionExpiry_, bytes32 sessionScope_) {
        if (owner_ == address(0) || entryPoint_ == address(0)) revert ZeroAddress();
        owner = owner_;
        entryPoint = entryPoint_;
        sessionKey = sessionKey_;
        sessionExpiry = sessionExpiry_;
        sessionScope = sessionScope_;
    }

    function validateUserOp(EntryPoint4337.UserOperation calldata op, bytes32 userOpHash) external view {
        if (msg.sender != entryPoint) revert Unauthorized();
        if (block.timestamp > op.validUntil) revert Expired();
        address signer = _recover(userOpHash, op.signature);
        if (signer == owner) return;
        if (sessionKey == address(0) || signer == address(0) || signer != sessionKey) revert Unauthorized();
        if (block.timestamp > sessionExpiry || op.validUntil > sessionExpiry) revert Expired();
        if (op.scopeHash != sessionScope) revert Scope();
    }

    function execute(address target, uint256 value, bytes calldata data) external {
        if (target == address(0)) revert ZeroAddress();
        if (msg.sender != entryPoint && msg.sender != owner) revert Unauthorized();
        (bool ok,) = target.call{value: value}(data);
        if (!ok) revert CallFailed();
    }

    function _recover(bytes32 hash, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v != 27 && v != 28) return address(0);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        return ecrecover(hash, v, r, s);
    }
}
