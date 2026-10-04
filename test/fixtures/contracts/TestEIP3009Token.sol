// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title TestEIP3009Token
/// @notice Minimal, dependency-free ERC-20 with EIP-3009 (transferWithAuthorization) and
///         EIP-2612 (permit) support. Used only as an interop-test fixture on anvil; it mirrors
///         the revert strings of Circle's FiatTokenV2 so the x402 facilitator's error mapping
///         behaves exactly as it does against USDC-style tokens.
/// @dev    Anyone can mint (faucet semantics). Never deploy this on a public network.
contract TestEIP3009Token {
    string public name;
    string public symbol;
    string public constant version = "1";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces; // EIP-2612
    mapping(address => mapping(bytes32 => bool)) private _authorizationStates; // EIP-3009

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
    }

    // ---------------------------------------------------------------- EIP-712

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                _EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, address(this)
            )
        );
    }

    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    // ---------------------------------------------------------------- faucet

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    // ---------------------------------------------------------------- ERC-20

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _approve(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "ERC20: transfer amount exceeds allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _approve(address owner, address spender, uint256 amount) internal {
        allowance[owner][spender] = amount;
        emit Approval(owner, spender, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal virtual {
        require(to != address(0), "ERC20: transfer to the zero address");
        require(balanceOf[from] >= amount, "ERC20: transfer amount exceeds balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    // ---------------------------------------------------------------- EIP-3009

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v));
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        _transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, signature);
    }

    function _transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) internal {
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(!_authorizationStates[from][nonce], "FiatTokenV2: authorization is used or canceled");

        bytes32 digest = _hashTypedData(
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))
        );
        require(_recover(digest, signature) == from, "FiatTokenV2: invalid signature");

        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    // ---------------------------------------------------------------- EIP-2612

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        require(block.timestamp <= deadline, "FiatTokenV2: permit is expired");
        bytes32 digest = _hashTypedData(keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline)));
        require(_recover(digest, abi.encodePacked(r, s, v)) == owner, "EIP2612: invalid signature");
        _approve(owner, spender, value);
    }

    // ---------------------------------------------------------------- ECDSA

    function _recover(bytes32 digest, bytes memory signature) internal pure returns (address) {
        require(signature.length == 65, "ECRecover: invalid signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        if (v < 27) v += 27;
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "ECRecover: invalid signature 's' value");
        require(v == 27 || v == 28, "ECRecover: invalid signature 'v' value");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "ECRecover: invalid signature");
        return signer;
    }
}

/// @notice EIP-3009 token whose transfers deliberately burn a lot of gas. Used to prove the
///         facilitator refuses to sponsor settlements above its per-transaction gas cap.
contract GasGuzzlerToken is TestEIP3009Token {
    uint256 public sink;

    constructor() TestEIP3009Token("Gas Guzzler", "GUZZ") {}

    function _transfer(address from, address to, uint256 amount) internal override {
        uint256 x = sink;
        for (uint256 i = 0; i < 40_000; i++) {
            x = uint256(keccak256(abi.encode(x, i)));
        }
        sink = x;
        super._transfer(from, to, amount);
    }
}

/// @notice EIP-3009 token whose transfer succeeds under `eth_call` (gas price 0) but reverts inside
///         a real transaction. Models a malicious asset that passes every pre-broadcast simulation and
///         then burns the sponsored gas on chain; used to prove that such a loss is bounded by the
///         per-transaction gas cap and charged to the daily budgets instead of going unnoticed.
contract SimOnlyToken is TestEIP3009Token {
    constructor() TestEIP3009Token("Sim Only", "SIMO") {}

    function _transfer(address from, address to, uint256 amount) internal override {
        require(tx.gasprice == 0, "SimOnly: reverts in a real transaction");
        super._transfer(from, to, amount);
    }
}

/// @notice Plain ERC-20 without EIP-3009 or EIP-2612. Used to prove the facilitator rejects
///         assets that cannot be settled gaslessly instead of broadcasting a doomed transaction.
contract PlainToken {
    string public name = "Plain Token";
    string public symbol = "PLAIN";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "ERC20: transfer amount exceeds balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "ERC20: transfer amount exceeds allowance");
        require(balanceOf[from] >= amount, "ERC20: transfer amount exceeds balance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @notice Minimal Multicall3-compatible `tryAggregate` so the x402 EVM facilitator's failure
///         diagnosis (which calls Multicall3 at its canonical address) works on anvil exactly as
///         it does on Whitechain, where the real Multicall3 is deployed.
contract MiniMulticall3 {
    struct Call {
        address target;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function tryAggregate(bool requireSuccess, Call[] calldata calls) external payable returns (Result[] memory returnData) {
        uint256 length = calls.length;
        returnData = new Result[](length);
        for (uint256 i = 0; i < length; i++) {
            (bool success, bytes memory ret) = calls[i].target.call(calls[i].callData);
            if (requireSuccess) require(success, "Multicall3: call failed");
            returnData[i] = Result(success, ret);
        }
    }
}
