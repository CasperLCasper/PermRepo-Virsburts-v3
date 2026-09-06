// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title PermRepoNFT
 * @dev Bezmaksas NFT ar repo piesaisti, backupiem un Merkle sakni.
 *      NFT ir migrējams (pārvedams uz citu maku), bet nepārdodams.
 */
contract PermRepoNFT is ERC721URIStorage, EIP712, Ownable2Step, ReentrancyGuard {

    bytes32 private constant ADD_BACKUP_TYPEHASH =
        keccak256("AddBackup(uint256 tokenId,uint256 backupNumber,bytes32 manifestHash,bytes32 merkleRoot,uint256 deadline,uint256 nonce)");

    uint256 private _nextTokenId = 1;

    mapping(uint256 => bytes32) public repositoryHash;
    mapping(bytes32 => uint256) public repositoryTokens;
    mapping(uint256 => uint256) public backupCount;
    mapping(uint256 => uint256) public nonces;
    mapping(uint256 => string) public lastManifestURI;
    mapping(uint256 => bytes32) public lastMerkleRoot;

    string public restorePageURI;

    event RepositoryMinted(address indexed owner, uint256 indexed tokenId, bytes32 indexed repoHash, string repository, string uri);
    event BackupAdded(uint256 indexed tokenId, uint256 indexed backupNumber, bytes32 indexed merkleRoot, bytes32 manifestHash, string manifestURI, uint256 nonce);
    event NFTRestored(uint256 indexed tokenId, address indexed from, address indexed to);
    event RestorePageURIUpdated(string oldURI, string newURI);

    error ZeroAddress();
    error EmptyInput();
    error RepositoryExists();
    error InvalidToken();
    error InvalidSignature();
    error DeadlineExpired();
    error NotOwner();

    constructor() 
        ERC721("PermRepo", "PREP") 
        EIP712("PermRepo", "1")
        Ownable(msg.sender) 
    {}

    // ==================================================
    // MINT (BEZMAKSAS)
    // ==================================================

    function mintRepository(
        address recipient,
        string calldata repository,
        string calldata uri
    ) external nonReentrant returns (uint256) {
        if (recipient == address(0)) revert ZeroAddress();
        if (bytes(repository).length == 0) revert EmptyInput();
        if (bytes(uri).length == 0) revert EmptyInput();

        bytes32 repoHash = keccak256(abi.encode(repository));
        if (repositoryTokens[repoHash] != 0) revert RepositoryExists();

        uint256 tokenId = _nextTokenId;
        unchecked { _nextTokenId++; }

        _safeMint(recipient, tokenId);
        _setTokenURI(tokenId, uri);

        repositoryHash[tokenId] = repoHash;
        repositoryTokens[repoHash] = tokenId;

        emit RepositoryMinted(recipient, tokenId, repoHash, repository, uri);

        return tokenId;
    }

    // ==================================================
    // MIGRĀCIJA (pārvedums, nevis pārdošana)
    // ==================================================

    function migrateNFT(uint256 tokenId, address newOwner) external nonReentrant {
        address currentOwner = ownerOf(tokenId);
        if (currentOwner != msg.sender) revert NotOwner();
        if (newOwner == address(0)) revert ZeroAddress();

        _transfer(currentOwner, newOwner, tokenId);

        emit NFTRestored(tokenId, currentOwner, newOwner);
    }

    // ==================================================
    // BACKUP
    // ==================================================

    function addBackup(
        uint256 tokenId,
        bytes32 manifestHash,
        bytes32 merkleRoot,
        string calldata manifestURI,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (bytes(manifestURI).length == 0) revert EmptyInput();

        bytes32 structHash = _hashAddBackup(tokenId, manifestHash, merkleRoot, deadline);

        address owner = ownerOf(tokenId);
        if (owner == address(0)) revert InvalidToken();
        if (ECDSA.recover(_hashTypedDataV4(structHash), signature) != owner) {
            revert InvalidSignature();
        }

        uint256 backupNumber = backupCount[tokenId] + 1;
        uint256 currentNonce = nonces[tokenId];

        nonces[tokenId] = currentNonce + 1;
        backupCount[tokenId] = backupNumber;
        lastManifestURI[tokenId] = manifestURI;
        lastMerkleRoot[tokenId] = merkleRoot;

        emit BackupAdded(tokenId, backupNumber, merkleRoot, manifestHash, manifestURI, currentNonce);
    }

    // ==================================================
    // PALĪGFUNKCIJAS
    // ==================================================

    function _hashAddBackup(
        uint256 tokenId,
        bytes32 manifestHash,
        bytes32 merkleRoot,
        uint256 deadline
    ) internal view returns (bytes32) {
        return keccak256(abi.encode(
            ADD_BACKUP_TYPEHASH,
            tokenId,
            backupCount[tokenId] + 1,
            manifestHash,
            merkleRoot,
            deadline,
            nonces[tokenId]
        ));
    }

    // ==================================================
    // VIEW
    // ==================================================

    function getTokenIdByRepo(string calldata repository) external view returns (uint256) {
        return repositoryTokens[keccak256(abi.encode(repository))];
    }

    function getRepositoryHash(uint256 tokenId) external view returns (bytes32) {
        return repositoryHash[tokenId];
    }

    function getBackupCount(uint256 tokenId) external view returns (uint256) {
        return backupCount[tokenId];
    }

    function getNonce(uint256 tokenId) external view returns (uint256) {
        return nonces[tokenId];
    }

    function getManifestURI(uint256 tokenId) external view returns (string memory) {
        return lastManifestURI[tokenId];
    }

    function getLastMerkleRoot(uint256 tokenId) external view returns (bytes32) {
        return lastMerkleRoot[tokenId];
    }

    function getRestorePageURI() external view returns (string memory) {
        return restorePageURI;
    }

    function getNFTInfo(uint256 tokenId) external view returns (
        bytes32 repoHash,
        uint256 backups,
        string memory manifestURI,
        bytes32 merkleRoot,
        address owner
    ) {
        return (
            repositoryHash[tokenId],
            backupCount[tokenId],
            lastManifestURI[tokenId],
            lastMerkleRoot[tokenId],
            ownerOf(tokenId)
        );
    }

    // ==================================================
    // ADMIN
    // ==================================================

    function setRestorePageURI(string calldata newURI) external onlyOwner {
        if (bytes(newURI).length == 0) revert EmptyInput();
        string memory oldURI = restorePageURI;
        restorePageURI = newURI;
        emit RestorePageURIUpdated(oldURI, newURI);
    }
}
