// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Roles} from "./Roles.sol";

/// @notice ERC-721-style series anchor for test rights references.
/// @dev This contract does not issue a security, equity, or a cash claim.
///      Metadata is frozen at mint. Transfers stay disabled unless a registrar enables them.
contract Dcnft is Roles {
    string public constant name = "DCNFT Series Reference";
    string public constant symbol = "DCNFT-TEST";
    string public constant disclaimer = "TEST_ONLY_NOT_A_SECURITY_AND_NOT_A_CASH_CLAIM";

    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => bytes32) public seriesId;
    mapping(uint256 => bytes32) public rightsDocumentDigest;
    mapping(uint256 => string) private _tokenURI;
    mapping(uint256 => bool) public exists;
    bool public transfersEnabled;

    error Exists();
    error MetadataFrozen();
    error TransfersDisabled();
    error NotOwner();

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    constructor(address admin) {
        if (block.chainid == 1) revert MainnetForbidden();
        _grant(DEFAULT_ADMIN, admin);
        _grant(REGISTRAR, admin);
        _grant(PAUSER, admin);
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        return _tokenURI[tokenId];
    }

    function mint(address to, uint256 tokenId, bytes32 series, bytes32 rightsDigest, string calldata uri)
        external
        onlyRole(REGISTRAR)
        onlyNonMainnet
        whenNotPaused
    {
        if (exists[tokenId]) revert Exists();
        exists[tokenId] = true;
        ownerOf[tokenId] = to;
        balanceOf[to] += 1;
        seriesId[tokenId] = series;
        rightsDocumentDigest[tokenId] = rightsDigest;
        _tokenURI[tokenId] = uri;
        emit Transfer(address(0), to, tokenId);
    }

    function setTokenURI(uint256, string calldata) external pure {
        revert MetadataFrozen();
    }

    function setTransfersEnabled(bool enabled) external onlyRole(REGISTRAR) whenNotPaused {
        transfersEnabled = enabled;
    }

    function transferFrom(address from, address to, uint256 tokenId) external whenNotPaused {
        if (!transfersEnabled) revert TransfersDisabled();
        if (ownerOf[tokenId] != from) revert NotOwner();
        if (msg.sender != from) revert Unauthorized(REGISTRAR);
        ownerOf[tokenId] = to;
        balanceOf[from] -= 1;
        balanceOf[to] += 1;
        emit Transfer(from, to, tokenId);
    }
}
