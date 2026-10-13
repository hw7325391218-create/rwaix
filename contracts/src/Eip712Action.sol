// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice EIP-712 digest for the reference Action struct. Matches packages/protocol EIP-712 encoding.
/// @dev EIP-712 itself does not stop replay. Callers still bind nonce and deadline.
contract Eip712Action {
    bytes32 internal constant TYPEHASH = keccak256(
        "Action(string protocolVersion,string action,uint256 chainId,string audience,string nonce,uint256 deadline,bytes32 payloadDigest)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function domainSeparator(uint256 chainId, address verifyingContract) public pure returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes("RWAIX")), keccak256(bytes("1")), chainId, verifyingContract)
        );
    }

    function digest(
        uint256 chainId,
        address verifyingContract,
        string memory protocolVersion,
        string memory action,
        string memory audience,
        string memory nonce,
        uint256 deadline,
        bytes32 payloadDigest
    ) public pure returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                TYPEHASH,
                keccak256(bytes(protocolVersion)),
                keccak256(bytes(action)),
                chainId,
                keccak256(bytes(audience)),
                keccak256(bytes(nonce)),
                deadline,
                payloadDigest
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(chainId, verifyingContract), structHash));
    }
}
