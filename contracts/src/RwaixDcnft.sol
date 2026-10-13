// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuard} from "./ReentrancyGuard.sol";
import {Roles} from "./Roles.sol";

/// @notice Deployable DCNFT shell.
/// @dev Construction grants admin and pauser only. It does not mint. REGISTRAR is not granted.
///      Transfers stay off. `issuanceEnabled` stays false until a later transaction that this
///      repository's deploy script never sends. Minting requires legal and compliance sign-off.
///      An ordinary NFT deployed here is not, by itself, an investment, copyright, or income right.
contract RwaixDcnft is Roles, ReentrancyGuard {
    string public constant name = "DCNFT";
    string public constant symbol = "DCNFT";
    string public constant issuanceNotice = "ISSUANCE_DISABLED_UNTIL_LEGAL_AND_COMPLIANCE_SIGNOFF";

    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => bytes32) public seriesId;
    mapping(uint256 => bytes32) public rightsDocumentDigest;
    mapping(uint256 => string) private _tokenURI;
    mapping(uint256 => bool) public exists;
    bool public transfersEnabled;
    bool public issuanceEnabled;

    error IssuanceDisabled();
    error Exists();
    error MetadataFrozen();
    error TransfersDisabled();
    error NotOwner();

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event IssuanceEnabled(address indexed admin);

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grant(DEFAULT_ADMIN, admin);
        _grant(PAUSER, admin);
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        return _tokenURI[tokenId];
    }

    /// @notice Opens the issuance gate. Does not grant REGISTRAR and does not mint.
    ///         Legal and compliance sign-off is required before anyone sends this transaction.
    function enableIssuance() external onlyRole(DEFAULT_ADMIN) {
        issuanceEnabled = true;
        emit IssuanceEnabled(msg.sender);
    }

    function mint(address to, uint256 tokenId, bytes32 series, bytes32 rightsDigest, string calldata uri)
        external
        nonReentrant
        onlyRole(REGISTRAR)
        whenNotPaused
    {
        if (!issuanceEnabled) revert IssuanceDisabled();
        if (to == address(0)) revert ZeroAddress();
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

    function transferFrom(address from, address to, uint256 tokenId) external nonReentrant whenNotPaused {
        if (!transfersEnabled) revert TransfersDisabled();
        if (to == address(0)) revert ZeroAddress();
        if (ownerOf[tokenId] != from) revert NotOwner();
        if (msg.sender != from) revert Unauthorized(REGISTRAR);
        ownerOf[tokenId] = to;
        balanceOf[from] -= 1;
        balanceOf[to] += 1;
        emit Transfer(from, to, tokenId);
    }
}
