// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract InayaToken {
    string public name = "Project Inaya";
    string public symbol = "INAYA";
    uint8 public decimals = 18;
    
    uint256 public totalSupply;
    uint256 public immutable maxSupplyCap; 
    
    // 💸 Micro-Fee Structure: 0.0001 tokens = 10^14 base units
    uint256 public constant transferFee = 100000000000000; 
    
    address public owner;
    address public treasuryWallet; 

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event FeeCollected(address indexed from, address indexed treasury, uint256 feeAmount);
    event Mint(address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Error: Only the contract owner can trigger this function");
        _;
    }

    constructor() {
        owner = msg.sender;
        treasuryWallet = msg.sender; 
        
        // Hardcoding your custom tokenomics parameters
        maxSupplyCap = 30000000 * (10 ** uint256(decimals)); // 🚀 30 Million Max Cap Lock
        
        // Minting the 5 Million Initial Supply directly to your founder wallet
        mint(msg.sender, 5000000); 
    }

    function transfer(address _to, uint256 _value) public returns (bool success) {
        uint256 totalDeduction = _value + transferFee;
        require(balanceOf[msg.sender] >= totalDeduction, "Error: Insufficient balance to cover amount + 0.0001 fee");
        
        balanceOf[msg.sender] -= totalDeduction;
        balanceOf[_to] += _value;
        balanceOf[treasuryWallet] += transferFee; 
        
        emit Transfer(msg.sender, _to, _value);
        emit FeeCollected(msg.sender, treasuryWallet, transferFee);
        return true;
    }

    function approve(address _spender, uint256 _value) public returns (bool success) {
        allowance[msg.sender][_spender] = _value;
        emit Approval(msg.sender, _spender, _value);
        return true;
    }

    function transferFrom(address _from, address _to, uint256 _value) public returns (bool success) {
        uint256 totalDeduction = _value + transferFee;
        require(balanceOf[_from] >= totalDeduction, "Error: Insufficient balance");
        require(allowance[_from][msg.sender] >= totalDeduction, "Error: Allowance exceeded");
        
        balanceOf[_from] -= totalDeduction;
        balanceOf[_to] += _value;
        balanceOf[treasuryWallet] += transferFee;
        
        allowance[_from][msg.sender] -= totalDeduction;
        
        emit Transfer(_from, _to, _value);
        emit FeeCollected(_from, treasuryWallet, transferFee);
        return true;
    }

    function mint(address _to, uint256 _amount) public onlyOwner returns (bool success) {
        uint256 tokensWithDecimals = _amount * (10 ** uint256(decimals));
        require(totalSupply + tokensWithDecimals <= maxSupplyCap, "Security Error: Hard Cap limit reached!");
        
        totalSupply += tokensWithDecimals;
        balanceOf[_to] += tokensWithDecimals;
        
        emit Mint(_to, tokensWithDecimals);
        emit Transfer(address(0), _to, tokensWithDecimals);
        return true;
    }

    function setTreasuryWallet(address _newTreasury) public onlyOwner {
        require(_newTreasury != address(0), "Error: Invalid address");
        treasuryWallet = _newTreasury;
    }
}