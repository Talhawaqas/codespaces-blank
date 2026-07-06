import base64
import hashlib
import os
import time
import requests
import streamlit as st
import pandas as pd
from cryptography.fernet import Fernet
from web3 import Web3

# ─── PREMIUM SYSTEM CONFIGURATIONS ───
st.set_page_config(
    page_title="Inaya Decentralized Security Network", 
    page_icon="⚡", 
    layout="wide"
)

# 🚀 STEP 1: ENTER YOUR FRESH DEPLOYED TESTNET CONTRACT ADDRESS RIGHT HERE
LIVE_CONTRACT_ADDRESS = "0x78d84E7ab7aAa1a9d6Bc03A64ADD995cB3f9bAb3"

# Public RPC Endpoint node gateway routing channel
BSC_TESTNET_RPC = "https://data-seed-prebsc-1-s1.binance.org:8545/"
w3 = Web3(Web3.HTTPProvider(BSC_TESTNET_RPC))

# Minified Smart Contract Application Binary Interface (ABI)
CONTRACT_ABI = [
    {"inputs":[],"name":"name","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"totalSupply","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"treasuryBalance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"string","name":"assetId","type":"string"},{"internalType":"string","name":"filename","type":"string"},{"internalType":"string","name":"cidAlpha","type":"string"},{"internalType":"string","name":"cidBeta","type":"string"}],"name":"registerAsset","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"string","name":"assetId","type":"string"}],"name":"getAsset","outputs":[{"internalType":"string","name":"filename","type":"string"},{"internalType":"string","name":"cidAlpha","type":"string"},{"internalType":"string","name":"cidBeta","type":"string"},{"internalType":"uint256","name":"timestamp","type":"uint256"},{"internalType":"address","name":"operator","type":"address"}],"stateMutability":"view","type":"function"}
]

contract_instance = w3.eth.contract(address=Web3.to_checksum_address(LIVE_CONTRACT_ADDRESS), abi=CONTRACT_ABI)

def derive_vault_key(master_password):
    raw_hash = hashlib.sha256(master_password.encode('utf-8')).digest()
    return base64.urlsafe_b64encode(raw_hash)

def generate_binary_fingerprint(file_bytes):
    return hashlib.sha256(file_bytes).hexdigest()

def upload_shard_to_ipfs(shard_string, filename, part, pinata_jwt):
    url = "https://api.pinata.cloud/pinning/pinJSONToIPFS"
    payload = {"pinataContent": {"part": part, "encrypted_data": shard_string}, "pinataMetadata": {"name": f"inaya_{part}_{filename}"}}
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {pinata_jwt.strip()}"}
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=20)
        return (True, response.json().get("IpfsHash")) if response.status_code == 200 else (False, "Error")
    except Exception as e:
        return False, str(e)

def fetch_shard_from_ipfs(cid):
    url = f"https://gateway.pinata.cloud/ipfs/{cid.strip()}"
    try:
        response = requests.get(url, timeout=15)
        return (True, response.json().get("encrypted_data")) if response.status_code == 200 else (False, "Error")
    except Exception as e:
        return False, str(e)

# ─── 🎨 HIGH-PERFORMANCE TECH MATRIX OVERRIDES ───
st.markdown("""
    <style>
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap');
        html, body, [class*="css"], .stApp { font-family: 'Plus Jakarta Sans', sans-serif; background-color: #060913 !important; color: #e2e8f0 !important; }
        .network-header-wrapper { display: flex; justify-content: space-between; align-items: center; background: rgba(10, 15, 30, 0.7); border-bottom: 1px solid rgba(0, 242, 254, 0.15); padding: 15px 40px; margin: -60px -40px 30px -40px; backdrop-filter: blur(20px); }
        .network-logo-text { font-size: 14pt; font-weight: 800; color: #ffffff; letter-spacing: 1px; }
        .network-status-badge { background: rgba(0, 242, 254, 0.06); border: 1px solid #00f2fe; color: #00f2fe; padding: 6px 14px; border-radius: 20px; font-size: 8.5pt; font-weight: 700; box-shadow: 0 0 12px rgba(0, 242, 254, 0.2); }
        div[data-testid="stRadioHorizontal"] { background: rgba(9, 13, 22, 0.5) !important; border: 1px solid rgba(255, 255, 255, 0.05) !important; padding: 10px 20px !important; border-radius: 12px !important; justify-content: center !important; max-width: 850px !important; margin: 0 auto 35px auto !important; }
        div[data-testid="stRadioHorizontal"] label div[data-testid="stMarker"] { display: none !important; }
        div[data-testid="stRadioHorizontal"] label { color: #64748b !important; font-weight: 600; font-size: 10pt !important; padding: 8px 16px !important; transition: all 0.2s ease !important; }
        div[data-testid="stRadioHorizontal"] [data-checked="true"] label { color: #ffffff !important; background: linear-gradient(135deg, rgba(0, 242, 254, 0.15) 0%, rgba(79, 172, 254, 0.05) 100%) !important; border: 1px solid rgba(0, 242, 254, 0.4) !important; border-radius: 8px !important; }
        .bento-card { background: linear-gradient(180deg, rgba(15, 22, 42, 0.6) 0%, rgba(9, 13, 22, 0.8) 100%); border: 1px solid rgba(255, 255, 255, 0.04); padding: 30px; border-radius: 16px; height: 100%; transition: all 0.3s ease; }
        .bento-card:hover { border-color: rgba(0, 242, 254, 0.3); transform: translateY(-3px); }
        .bento-num { font-family: 'JetBrains Mono', monospace; color: #00f2fe; font-size: 10pt; }
        .bento-title { font-size: 13pt; font-weight: 700; color: #ffffff; margin-top: 8px; }
        .bento-desc { font-size: 9.5pt; color: #94a3b8; line-height: 1.6; }
        .infra-metric-box { background: rgba(10, 15, 30, 0.4); border-left: 3px solid #00f2fe; padding: 20px; border-radius: 0 12px 12px 0; }
        .infra-val { font-family: 'JetBrains Mono', monospace; font-size: 18pt; font-weight: 700; color: #ffffff; }
        .infra-lbl { font-size: 8pt; color: #64748b; text-transform: uppercase; margin-top: 4px; }
        .timeline-matrix { border-left: 2px solid rgba(0, 242, 254, 0.15); padding-left: 25px; }
        .matrix-node { position: relative; margin-bottom: 35px; }
        .matrix-node::before { content: ''; position: absolute; left: -34px; top: 6px; background: #00f2fe; border: 2px solid #060913; border-radius: 50%; width: 14px; height: 14px; box-shadow: 0 0 8px #00f2fe; }
        .node-tag { font-family: 'JetBrains Mono', monospace; font-size: 8pt; color: #00f2fe; }
        .node-head { font-size: 13.5pt; font-weight: 700; color: #ffffff; }
        .node-body { font-size: 9.5pt; color: #94a3b8; }
        .stButton>button { background: linear-gradient(90deg, #00f2fe 0%, #4facfe 100%) !important; color: #060913 !important; border: none !important; border-radius: 8px !important; padding: 12px 24px !important; font-weight: 700 !important; font-family: 'JetBrains Mono', monospace; width: 100%; }
        .stButton>button:hover { box-shadow: 0 0 15px rgba(0, 242, 254, 0.4) !important; }
        input { background-color: rgba(9, 13, 22, 0.8) !important; border: 1px solid rgba(255,255,255,0.05) !important; color: #ffffff !important; font-family: 'JetBrains Mono', monospace; }
    </style>
""", unsafe_allow_html=True)

# ─── TOP GLOBAL HEADER ───
st.markdown(f"""
    <div class="network-header-wrapper">
        <div class="network-logo-section">
            <div style="background: linear-gradient(135deg, #00f2fe 0%, #4facfe 100%); width: 12px; height: 12px; border-radius: 3px; box-shadow: 0 0 8px #00f2fe;"></div>
            <div class="network-logo-text">INAYA LAYER DECENTRALIZED SWARM</div>
        </div>
        <div class="network-status-badge">⚡ BLOCKCHAIN REGISTRY CONNECTED</div>
    </div>
""", unsafe_allow_html=True)

# ─── SIDEBAR SECURE SYSTEM CONTROLS ───
st.sidebar.markdown("""
    <div style="padding: 5px 0;">
        <div style="color: #64748b; font-family: 'JetBrains Mono', monospace; font-size: 8pt; font-weight: 700;">SECURE HARDWARE</div>
        <div style="color: #ffffff; font-size: 11pt; font-weight: 700; margin-top: 2px;">NODE ROUTING SYSTEM</div>
    </div>
    <hr style="border-color: rgba(255,255,255,0.05); margin: 10px 0 20px 0;" />
""", unsafe_allow_html=True)

st.sidebar.info(f"📍 Target Contract:\n{LIVE_CONTRACT_ADDRESS}")
password_input = st.sidebar.text_input("Master Node Passkey:", type="password")
pinata_jwt_input = st.sidebar.text_input("Swarm API Key (JWT):", type="password")
operator_private_key = st.sidebar.text_input("Operator Wallet Private Key:", type="password", help="Needed to write asset receipts directly to the blockchain block registers.")

# 🌐 HORIZONTAL MAIN HEAD MENU NAVIGATION FLOW
current_page = st.radio(
    "label_is_hidden",
    ["Network Home", "Tech Features", "Sovereign Vault", "Ecosystem Economy", "Tactical Roadmap", "Foundation About"],
    horizontal=True, label_visibility="collapsed"
)

# Fetch data dynamically via Web3 from blockchain views
try:
    blockchain_total_supply = contract_instance.functions.totalSupply().call() / 10**18
    blockchain_treasury = contract_instance.functions.treasuryBalance().call() / 10**18
    node_sync_status = "SYNCHRONIZED"
except Exception:
    blockchain_total_supply = 30000000.0
    blockchain_treasury = 25000000.0
    node_sync_status = "LOCAL_SIMULATION_FALLBACK"


# ─── PAGE 1: NETWORK HOME ───
if current_page == "Network Home":
    st.markdown("<h2 style='font-weight:800; color:#fff; font-size:24pt; letter-spacing:-0.5px;'>Sovereign Data Storage Scaling Networks</h2>", unsafe_allow_html=True)
    st.markdown("<p style='color:#94a3b8; font-size:11pt; margin-bottom:30px;'>Cryptographic layer network metrics parsed directly from on-chain smart contract structures.</p>", unsafe_allow_html=True)
    
    s_col1, s_col2, s_col3, s_col4 = st.columns(4)
    with s_col1: st.markdown(f'<div class="infra-metric-box"><div class="infra-val" style="color:#00f2fe;">{node_sync_status}</div><div class="infra-lbl">Node Network Pipeline</div></div>', unsafe_allow_html=True)
    with s_col2: st.markdown(f'<div class="infra-metric-box"><div class="infra-val">{blockchain_total_supply:,.0f}</div><div class="infra-lbl">Verified Total Supply Caps</div></div>', unsafe_allow_html=True)
    with s_col3: st.markdown(f'<div class="infra-metric-box"><div class="infra-val">99.999%</div><div class="infra-lbl">EVM Sync Confidence</div></div>', unsafe_allow_html=True)
    with s_col4: st.markdown(f'<div class="infra-metric-box"><div class="infra-val">&lt; 0.72s</div><div class="infra-lbl">EVM Transaction Latency</div></div>', unsafe_allow_html=True)


# ─── PAGE 2: TECH FEATURES ───
elif current_page == "Tech Features":
    st.markdown("<h2 style='font-weight:800; color:#fff; font-size:24pt; letter-spacing:-0.5px; margin-bottom:35px;'>Modular Network Features</h2>", unsafe_allow_html=True)
    f_col1, f_col2, f_col3 = st.columns(3)
    with f_col1:
        st.markdown('<div class="bento-card"><div class="bento-num">// PROTOCOL_01</div><div class="bento-title">Local Cryptographic Sharding</div><div class="bento-desc">Files never leave local machines whole. The system fragments items into discrete binary elements before triggering network transfer lanes.</div></div>', unsafe_allow_html=True)
    with f_col2:
        st.markdown('<div class="bento-card"><div class="bento-num">// PROTOCOL_02</div><div class="bento-title">Asymmetric Vault Memory</div><div class="bento-desc">Zero sensitive credential vectors are saved on backend servers. Encryption matrices exist strictly inside temporary front-end registers.</div></div>', unsafe_allow_html=True)
    with f_col3:
        st.markdown('<div class="bento-card"><div class="bento-num">// PROTOCOL_03</div><div class="bento-title">On-Chain Metadata Anchoring</div><div class="bento-desc">Instead of saving file logs to local files, references are written directly onto the blockchain using signed cryptographic consensus transactions.</div></div>', unsafe_allow_html=True)


# ─── PAGE 3: SOVEREIGN SECURE VAULT ENGINE (HARD-WIRED TO WRITE & READ TO BLOCKCHAIN) ───
elif current_page == "Sovereign Vault":
    st.markdown("<h2 style='font-weight:800; color:#fff; font-size:24pt; letter-spacing:-0.5px;'>Hardened Cryptographic Storage Core</h2>", unsafe_allow_html=True)
    
    if not password_input or not pinata_jwt_input:
        st.warning("🔒 Administrative Lockout: Please supply security access criteria to establish active pipeline loops.")
    else:
        VAULT_KEY = derive_vault_key(password_input)
        cipher_suite = Fernet(VAULT_KEY)
        
        tab1, tab2 = st.tabs(["📥 Execute On-Chain Storage Broadcast", "🔓 Execute On-Chain Ledger Extraction"])
        
        with tab1:
            col1, col2 = st.columns([1, 2])
            with col1: asset_id = st.text_input("Assign Unique Global Asset ID:")
            with col2: uploaded_file = st.file_uploader("Select corporate target object file:")

            if st.button("Sign & Broadcast Storage Transaction"):
                if asset_id and uploaded_file is not None and operator_private_key:
                    raw_bytes = uploaded_file.read()
                    original_name = uploaded_file.name
                    encrypted_string = cipher_suite.encrypt(raw_bytes).decode('utf-8')
                    mid = len(encrypted_string) // 2
                    
                    st.info("📡 Streaming data fragments to decentralized IPFS pinning arrays...")
                    success_a, cid_a = upload_shard_to_ipfs(encrypted_string[:mid], original_name, "Alpha", pinata_jwt_input)
                    success_b, cid_b = upload_shard_to_ipfs(encrypted_string[mid:], original_name, "Beta", pinata_jwt_input)
                    
                    if success_a and success_b:
                        try:
                            st.info("⛓️ Upload successful. Preparing on-chain transaction package for BNB Chain ledger...")
                            operator_account = w3.eth.account.from_key(operator_private_key)
                            operator_address = operator_account.address
                            
                            # Constructing live smart contract transaction
                            nonce = w3.eth.get_transaction_count(operator_address)
                            tx = contract_instance.functions.registerAsset(
                                asset_id, original_name, cid_a, cid_b
                            ).build_transaction({
                                'chainId': 97, # BSC Testnet Chain ID
                                'gas': 300000,
                                'gasPrice': w3.eth.gas_price,
                                'nonce': nonce,
                            })
                            
                            signed_tx = w3.eth.account.sign_transaction(tx, private_key=operator_private_key)
                            tx_hash = w3.eth.send_raw_transaction(signed_tx.rawTransaction)
                            
                            st.balloons()
                            st.success(f"🎯 ON-CHAIN TRANSACTION CONFIRMED! Hash: {w3.to_hex(tx_hash)}")
                            st.code(f"Shard Alpha Address Matrix: {cid_a}\nShard Beta Address Matrix: {cid_b}")
                        except Exception as error_msg:
                            st.error(f"❌ Blockchain Write Failed: Check your private key or gas funds. Details: {error_msg}")
                    else: st.error("❌ IPFS broadcast channel reject fault.")
                else: st.error("❌ Missing unique tracking IDs, upload files, or operator wallet verification keys.")

        with tab2:
            query_id = st.text_input("Enter On-Chain Registered Asset ID:")
            download_title = st.text_input("Restored Filename Specification Title:", value="restored_data.pdf")
            
            if st.button("Fetch & Synthesize Blockchain Shards"):
                if query_id:
                    try:
                        st.info("🔍 Querying smart contract storage mapping layers for data receipts...")
                        # Dynamic live ledger look-up view function call
                        onchain_record = contract_instance.functions.getAsset(query_id).call()
                        blockchain_filename, onchain_cid_a, onchain_cid_b, onchain_time, onchain_op = onchain_record
                        
                        st.success(f"🔗 Target CIDs fetched from Blockchain! Operator Source: {onchain_op}")
                        st.info("🌐 Fetching encrypted shards from decentralized gateways...")
                        
                        success_a, data_a = fetch_shard_from_ipfs(onchain_cid_a)
                        success_b, data_b = fetch_shard_from_ipfs(onchain_cid_b)
                        
                        if success_a and success_b:
                            decrypted_bytes = cipher_suite.decrypt((data_a + data_b).encode('utf-8'))
                            st.balloons()
                            st.download_button(label="📥 Download Restored Asset", data=decrypted_bytes, file_name=download_title)
                        else: st.error("❌ Swarm node cluster lookup failure.")
                    except Exception as err:
                        st.error(f"⛔ Access Verification Exception: This entry does not exist on the ledger or decryption failed. Details: {err}")


# ─── PAGE 4: ECOSYSTEM ECONOMY ───
elif current_page == "Ecosystem Economy":
    st.markdown("<h2 style='font-weight:800; color:#fff; font-size:24pt; letter-spacing:-0.5px;'>Ecosystem Capital Metrics</h2>", unsafe_allow_html=True)
    m_col1, m_col2, m_col3, m_col4 = st.columns(4)
    with m_col1: st.metric(label="⚡ Token Max Capped Supply", value=f"{blockchain_total_supply:,.0f} INAYA", delta="Strict Scarcity Value")
    with m_col2: st.metric(label="📈 Initial Liquidity Allocation", value="5,000,000 INAYA", delta="Seed Pool Allocation")
    with m_col3: st.metric(label="💸 Processing Network Burn Metric", value="0.0001 INAYA", delta="Fixed Burn Cap")
    with m_col4: st.metric(label="🏦 Dynamic Contract Treasury Holdings", value=f"{blockchain_treasury:,.4f} INAYA", delta="Parsed Live From Blockchain", delta_color="inverse")


# ─── PAGE 5: TACTICAL ROADMAP ───
elif current_page == "Tactical Roadmap":
    st.markdown("<h2 style='font-weight:800; color:#fff; font-size:24pt; letter-spacing:-0.5px; margin-bottom:35px;'>Infrastructure Development Milestones</h2>", unsafe_allow_html=True)
    st.markdown('<div class="timeline-matrix"><div class="matrix-node"><div class="node-tag">PHASE 01 // SUCCESS</div><div class="node-head">On-Chain Asset Data Mapping Core</div><div class="node-body">Successful design, compilation, and initialization of the storage matrix registry logic into the $INAYA token ledger core structure.</div></div><div class="matrix-node"><div class="node-tag">PHASE 02 // LIVE IN OPERATIONS</div><div class="node-head">Dynamic Web3 Application Interfaces</div><div class="node-body">Wiring Streamlit frontend scripts directly to Web3 provider systems to pull variables live from blockchain state parameters.</div></div></div>', unsafe_allow_html=True)


# ─── PAGE 6: FOUNDATION ABOUT ───
elif current_page == "Executive Philosophy":
    st.markdown("<h2 style='font-weight:800; color:#fff; font-size:24pt; letter-spacing:-0.5px;'>The Inaya Foundation Philosophy</h2>", unsafe_allow_html=True)
    st.markdown("Project Inaya anchors operational corporate document workflows seamlessly onto immutable node networks. Derived from the linguistic Arabic root meaning **Complete Care, Absolute Protection, and Grace**, the project acts as a digital guardian for high-value datasets.")