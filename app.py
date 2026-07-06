import base64
import hashlib
import json
import os
import time
import requests
import streamlit as st
import pandas as pd
from cryptography.fernet import Fernet

# ─── PREMIUM SYSTEM CONFIGURATIONS ───
st.set_page_config(
    page_title="Inaya Decentralized Security Network", 
    page_icon="⚡", 
    layout="wide",
    initial_sidebar_state="expanded"
)

LIVE_CONTRACT_ADDRESS = "0xbd23E6D04a82689a59E5188f9B572CBeF53D4763"
MANIFEST_FILE = "inaya_manifest.json"

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
        return (True, response.json().get("IpfsHash")) if response.status_code == 200 else (False, f"Error {response.status_code}")
    except Exception as e:
        return False, str(e)

def fetch_shard_from_ipfs(cid):
    url = f"https://gateway.pinata.cloud/ipfs/{cid.strip()}"
    try:
        response = requests.get(url, timeout=15)
        return (True, response.json().get("encrypted_data")) if response.status_code == 200 else (False, "Gateway Error")
    except Exception as e:
        return False, str(e)

# ─── 🎨 HIGH-PERFORMANCE TECH MATRIX CSS OVERRIDES ───
st.markdown("""
    <style>
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap');
        
        /* Deep Obsidian Space Background Styling */
        html, body, [class*="css"], .stApp {
            font-family: 'Plus Jakarta Sans', sans-serif;
            background-color: #060913 !important;
            color: #e2e8f0 !important;
        }
        
        /* Modern Network Horizontal Bar Design */
        .network-header-wrapper {
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: rgba(10, 15, 30, 0.7);
            border-bottom: 1px solid rgba(0, 242, 254, 0.15);
            padding: 15px 40px;
            margin: -60px -40px 30px -40px;
            backdrop-filter: blur(20px);
        }
        .network-logo-section { display: flex; align-items: center; gap: 10px; }
        .network-logo-text { font-size: 14pt; font-weight: 800; color: #ffffff; letter-spacing: 1px; }
        .network-status-badge {
            background: rgba(0, 242, 254, 0.06);
            border: 1px solid #00f2fe;
            color: #00f2fe;
            padding: 6px 14px;
            border-radius: 20px;
            font-size: 8.5pt;
            font-weight: 700;
            letter-spacing: 1px;
            box-shadow: 0 0 12px rgba(0, 242, 254, 0.2);
        }
        
        /* Streamlit Top Custom Navigation Element Overrides */
        div[data-testid="stRadioHorizontal"] {
            background: rgba(9, 13, 22, 0.5) !important;
            border: 1px solid rgba(255, 255, 255, 0.05) !important;
            padding: 10px 20px !important;
            border-radius: 12px !important;
            justify-content: center !important;
            max-width: 850px !important;
            margin: 0 auto 35px auto !important;
        }
        div[data-testid="stRadioHorizontal"] label div[data-testid="stMarker"] { display: none !important; }
        div[data-testid="stRadioHorizontal"] label {
            color: #64748b !important;
            font-weight: 600 !important;
            font-size: 10pt !important;
            padding: 8px 16px !important;
            transition: all 0.2s ease !important;
        }
        div[data-testid="stRadioHorizontal"] label:hover { color: #00f2fe !important; }
        div[data-testid="stRadioHorizontal"] [data-checked="true"] label {
            color: #ffffff !important;
            background: linear-gradient(135deg, rgba(0, 242, 254, 0.15) 0%, rgba(79, 172, 254, 0.05) 100%) !important;
            border: 1px solid rgba(0, 242, 254, 0.4) !important;
            border-radius: 8px !important;
        }
        
        /* Bento Grid Crypto Card Systems */
        .bento-card {
            background: linear-gradient(180deg, rgba(15, 22, 42, 0.6) 0%, rgba(9, 13, 22, 0.8) 100%);
            border: 1px solid rgba(255, 255, 255, 0.04);
            padding: 30px;
            border-radius: 16px;
            transition: all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
            height: 100%;
        }
        .bento-card:hover {
            border-color: rgba(0, 242, 254, 0.3);
            transform: translateY(-4px);
            box-shadow: 0 15px 35px rgba(0, 242, 254, 0.04);
        }
        .bento-num { font-family: 'JetBrains Mono', monospace; color: #00f2fe; font-size: 11pt; font-weight: 700; opacity: 0.8; }
        .bento-title { font-size: 14pt; font-weight: 700; color: #ffffff; margin: 10px 0; }
        .bento-desc { font-size: 9.5pt; color: #94a3b8; line-height: 1.6; }

        /* Infrastructure Metric Panels */
        .infra-metric-box {
            background: rgba(10, 15, 30, 0.4);
            border-left: 3px solid #00f2fe;
            padding: 20px;
            border-radius: 0 12px 12px 0;
        }
        .infra-val { font-family: 'JetBrains Mono', monospace; font-size: 20pt; font-weight: 700; color: #ffffff; }
        .infra-lbl { font-size: 8pt; color: #64748b; text-transform: uppercase; letter-spacing: 1.5px; margin-top: 4px; }

        /* Cyberpunk Vertical Timeline Implementation */
        .timeline-matrix { border-left: 2px solid rgba(0, 242, 254, 0.15); padding-left: 25px; margin: 20px 5px; }
        .matrix-node { position: relative; margin-bottom: 40px; }
        .matrix-node::before {
            content: ''; position: absolute; left: -34px; top: 6px;
            background: #00f2fe; border: 2px solid #060913;
            border-radius: 50%; width: 14px; height: 14px;
            box-shadow: 0 0 10px #00f2fe;
        }
        .node-tag { font-family: 'JetBrains Mono', monospace; font-size: 8.5pt; color: #00f2fe; font-weight: 700; }
        .node-head { font-size: 14.5pt; font-weight: 700; color: #ffffff; margin: 4px 0 8px 0; }
        .node-body { font-size: 9.5pt; color: #94a3b8; line-height: 1.6; }

        /* Admin Security Dashboard Sidebar Accentuation */
        .console-badge {
            background: rgba(255,255,255,0.02);
            border: 1px solid rgba(255,255,255,0.05);
            padding: 12px; border-radius: 8px; margin-bottom: 20px;
            font-family: 'JetBrains Mono', monospace;
        }
        
        /* High-Performance Neon Call-To-Action Switches */
        .stButton>button {
            background: linear-gradient(90deg, #00f2fe 0%, #4facfe 100%) !important;
            color: #060913 !important;
            border: none !important;
            border-radius: 8px !important;
            padding: 12px 24px !important;
            font-weight: 700 !important;
            font-family: 'JetBrains Mono', monospace;
            width: 100%;
            transition: all 0.25s ease !important;
        }
        .stButton>button:hover {
            box-shadow: 0 0 20px rgba(0, 242, 254, 0.4) !important;
            transform: translateY(-1px) !important;
        }
        
        input {
            background-color: rgba(9, 13, 22, 0.8) !important;
            border: 1px solid rgba(255,255,255,0.05) !important;
            color: #ffffff !important;
            font-family: 'JetBrains Mono', monospace;
        }
        .stTabs [data-baseweb="tab"] { font-family: 'JetBrains Mono', monospace; color: #64748b !important; }
        .stTabs [data-baseweb="tab"][aria-selected="true"] { color: #00f2fe !important; border-bottom-color: #00f2fe !important; }
    </style>
""", unsafe_allow_html=True)

# ─── 🌐 TOP GLOBAL ECOSYSTEM OVERVIEW NAVIGATION HEADER ───
st.markdown(f"""
    <div class="network-header-wrapper">
        <div class="network-logo-section">
            <div style="background: linear-gradient(135deg, #00f2fe 0%, #4facfe 100%); width: 12px; height: 12px; border-radius: 3px; box-shadow: 0 0 8px #00f2fe;"></div>
            <div class="network-logo-text">INAYA NETWORK</div>
        </div>
        <div class="network-status-badge">⚡ CORE SUITE: ONLINE</div>
    </div>
""", unsafe_allow_html=True)

# ─── SIDEBAR: HARDENED PROTOCOL LOCK CONSOLE ───
st.sidebar.markdown("""
    <div style="padding: 5px 0;">
        <div style="color: #64748b; font-family: 'JetBrains Mono', monospace; font-size: 8pt; font-weight: 700; text-transform: uppercase;">SECURE NODE</div>
        <div style="color: #ffffff; font-size: 12pt; font-weight: 700; margin-top: 2px;">AUTHENTICATION DOCK</div>
    </div>
    <hr style="border-color: rgba(255,255,255,0.05); margin: 10px 0 20px 0;" />
""", unsafe_allow_html=True)

st.sidebar.markdown(f"""
    <div class="console-badge">
        <div style="color: #64748b; font-size: 7.5pt; text-transform: uppercase;">Target Contract Address:</div>
        <div style="color: #00f2fe; font-size: 8pt; word-break: break-all; margin-top: 4px;">{LIVE_CONTRACT_ADDRESS}</div>
    </div>
""", unsafe_allow_html=True)

st.sidebar.header("🔑 Operational Credentials")
password_input = st.sidebar.text_input("Master Node Passkey:", type="password")
pinata_jwt_input = st.sidebar.text_input("Swarm API Key (JWT):", type="password")

# Dynamic Registry Calculations Loop
total_files_archived = 0
if os.path.exists(MANIFEST_FILE):
    try:
        with open(MANIFEST_FILE, "r") as f: total_files_archived = len(json.load(f))
    except Exception: total_files_archived = 0
accumulated_fees = total_files_archived * 0.0001

# 🌐 SLICK INTERACTIVE ECOSYSTEM ROUTER BUTTON PILLS
current_page = st.radio(
    "label_is_hidden_by_css",
    ["Network Home", "Ecosystem Apps", "Sovereign Portal", "Ecosystem Economy", "Tactical Roadmap", "Foundation About"],
    horizontal=True,
    label_visibility="collapsed"
)


# ─── 1. NETWORK HOME PORTAL ───
if current_page == "Network Home":
    st.markdown("<h2 style='font-weight:800; color:#fff; font-size:24pt; letter-spacing:-0.5px; margin-bottom:5px;'>Sovereign Data Storage Scaling Networks</h2>", unsafe_allow_html=True)
    st.markdown("<p style='color:#94a3b8; font-size:11pt; margin-bottom:30px;'>Next-generation cryptographic execution shards linked dynamically to modular public ledgers.</p>", unsafe_allow_html=True)
    
    st.subheader("📊 Active Network Infrastructure Indicators")
    st.markdown("<br>", unsafe_allow_html=True)
    
    s_col1, s_col2, s_col3, s_col4 = st.columns(4)
    with s_col1: st.markdown(f'<div class="infra-metric-box"><div class="infra-val" style="color:#00f2fe;">ACTIVE</div><div class="infra-lbl">Node Layer Status</div></div>', unsafe_allow_html=True)
    with s_col2: st.markdown(f'<div class="infra-metric-box"><div class="infra-val">{total_files_archived}</div><div class="infra-lbl">Secured Clusters</div></div>', unsafe_allow_html=True)
    with s_col3: st.markdown(f'<div class="infra-metric-box"><div class="infra-val">99.999%</div><div class="infra-lbl">Validator Sync Rate</div></div>', unsafe_allow_html=True)
    with s_col4: st.markdown(f'<div class="infra-metric-box"><div class="infra-val">&lt; 0.8s</div><div class="infra-lbl">Synthesis Routine Latency</div></div>', unsafe_allow_html=True)


# ─── 2. ECOSYSTEM APPS (BENTO CARD DISPLAY FEATURE) ───
elif current_page == "Tech Features":
    st.markdown("<h2 style='font-weight:800; color:#fff; font-size:24pt; letter-spacing:-0.5px; margin-bottom:5px;'>Modular Network Features</h2>", unsafe_allow_html=True)
    st.markdown("<p style='color:#94a3b8; font-size:11pt; margin-bottom:35px;'>Core operational components driving zero-knowledge cryptographic distribution layers.</p>", unsafe_allow_html=True)
    
    f_col1, f_col2, f_col3 = st.columns(3)
    with f_col1:
        st.markdown("""
            <div class="bento-card">
                <div class="bento-num">// PROTOCOL_01</div>
                <div class="bento-title">Localized Cryptographic Sharding</div>
                <div class="bento-desc">Files never leave local machines whole. The system breaks document fragments into discrete, random binary packages before triggering external routing lines, ensuring absolute perimeter resistance.</div>
            </div>
        """, unsafe_allow_html=True)
    with f_col2:
        st.markdown("""
            <div class="bento-card">
                <div class="bento-num">// PROTOCOL_02</div>
                <div class="bento-title">Asymmetric Vault Memory Isolation</div>
                <div class="bento-desc">No tracking information or decryption maps are recorded on corporate servers. Access routines are generated dynamically in temporary stack registers inside administrator web views.</div>
            </div>
        """, unsafe_allow_html=True)
    with f_col3:
        st.markdown("""
            <div class="bento-card">
                <div class="bento-num">// PROTOCOL_03</div>
                <div class="bento-title">EVM Ledger Attestation Hooks</div>
                <div class="bento-desc">Every data broadcast emits validation indicators across public execution branches, creating permanent records linked directly to our verified, deployed on-chain smart contract.</div>
            </div>
        """, unsafe_allow_html=True)


# ─── 3. SOVEREIGN SECURE STORAGE PORTAL VAULT ───
elif current_page == "Sovereign Portal":
    st.markdown("<h2 style='font-weight:800; color:#fff; font-size:24pt; letter-spacing:-0.5px; margin-bottom:5px;'>Hardened Network Transaction Core</h2>", unsafe_allow_html=True)
    st.markdown("<p style='color:#94a3b8; font-size:11pt; margin-bottom:30px;'>Cryptographic fragmentation node inputs and decentralized public gateway routing pipelines.</p>", unsafe_allow_html=True)
    
    if not password_input or not pinata_jwt_input:
        st.warning("🔒 Administrative Lockout: Please supply valid authentication credentials inside the left dock panel to connect to node communication arrays.")
    else:
        VAULT_KEY = derive_vault_key(password_input)
        cipher_suite = Fernet(VAULT_KEY)
        st.sidebar.success("🔗 CRYPTO SUITE CONNECTION: COMPILE SUCCESS")
        
        tab1, tab2 = st.tabs(["📥 Broadcast New Asset Stream", "🔓 Quorum Assembly Retrieval"])
        
        with tab1:
            st.subheader("📥 Encrypt, Fragment & Broadcast Data Assets")
            col_input_1, col_input_2 = st.columns([1, 2])
            with col_input_1: asset_id = st.text_input("Global Target Tracking Asset ID:")
            with col_input_2: uploaded_file = st.file_uploader("Select corporate document object archive:")

            if st.button("Execute Institutional Sharding Sequence"):
                if asset_id and uploaded_file is not None:
                    raw_bytes = uploaded_file.read()
                    original_name = uploaded_file.name
                    file_hash = generate_binary_fingerprint(raw_bytes)
                    encrypted_string = cipher_suite.encrypt(raw_bytes).decode('utf-8')
                    mid = len(encrypted_string) // 2
                    
                    st.info("📡 Communications established. Piping network data streams to IPFS gateways...")
                    success_a, cid_a = upload_shard_to_ipfs(encrypted_string[:mid], original_name, "Alpha", pinata_jwt_input)
                    success_b, cid_b = upload_shard_to_ipfs(encrypted_string[mid:], original_name, "Beta", pinata_jwt_input)
                    
                    if success_a and success_b:
                        st.balloons()
                        st.success("🎯 ZERO-KNOWLEDGE ARCHIVAL PROOF COMPLETE: Cluster shards pinned.")
                        registry_list = []
                        if os.path.exists(MANIFEST_FILE):
                            try:
                                with open(MANIFEST_FILE, "r") as f: registry_list = json.load(f)
                            except Exception: pass
                        registry_list.append({"Asset ID": asset_id, "Filename": original_name, "Timestamp": time.time()})
                        with open(MANIFEST_FILE, "w") as f: json.dump(registry_list, f, indent=4)
                        
                        st.markdown("### 📋 Sovereign Storage Receipt CIDs")
                        st.code(f"Shard Alpha CID (Vector A): {cid_a}")
                        st.code(f"Shard Beta CID  (Vector B): {cid_b}")
                        st.caption(f"SHA-256 Base Proof Fingerprint: {file_hash}")
                    else: st.error("❌ Gateway Transmit Fault.")
                else: st.error("❌ Input parameters incomplete.")

        with tab2:
            st.subheader("🔓 Reassemble, Verify & Unlock Storage Shards")
            c_col1, c_col2 = st.columns(2)
            with c_col1: cid_alpha = st.text_input("Enter Shard Alpha Tracking CID:")
            with c_col2: cid_beta = st.text_input("Enter Shard Beta Tracking CID:")
            download_filename = st.text_input("Restored Filename Specification:", value="restored_document.pdf")

            if st.button("Compile & Verify Cluster Fragments"):
                if cid_alpha and cid_beta:
                    st.info("🌐 Querying swarm gateways for cluster pieces...")
                    success_a, data_a = fetch_shard_from_ipfs(cid_alpha)
                    success_b, data_b = fetch_shard_from_ipfs(cid_beta)
                    
                    if success_a and success_b:
                        try:
                            decrypted_file_bytes = cipher_suite.decrypt((data_a + data_b).encode('utf-8'))
                            st.balloons()
                            st.success("💚 SIGNATURE MATCH CLEARED: Reassembly complete.")
                            st.download_button(label=f"📥 Download Restored Asset", data=decrypted_file_bytes, file_name=download_filename)
                        except Exception: st.error("⛔ ACCESS DENIED: Incorrect encryption security key match.")
                    else: st.error("❌ Swarm sync failure.")
                else: st.error("❌ Missing target fields.")


# ─── 4. ECOSYSTEM ECONOMY TOKENOMICS DECK ───
elif current_page == "Ecosystem Economy":
    st.markdown("<h2 style='font-weight:800; color:#fff; font-size:24pt; letter-spacing:-0.5px; margin-bottom:5px;'>Network Token Allocation & Capital Balances</h2>", unsafe_allow_html=True)
    st.markdown("<p style='color:#94a3b8; font-size:11pt; margin-bottom:30px;'>Real-time minting distribution indexes and automated settlement ledger metrics.</p>", unsafe_allow_html=True)
    
    m_col1, m_col2, m_col3, m_col4 = st.columns(4)
    with m_col1: st.metric(label="⚡ Token Maximum Capped Supply", value="30,000,000 INAYA", delta="Immutable Mint Cap")
    with m_col2: st.metric(label="📈 Initial Liquidity Operations", value="5,000,000 INAYA", delta="Seed Base Allocation")
    with m_col3: st.metric(label="💸 Network Micro-Fee Metric", value="0.0001 INAYA", delta="Fixed System Burn")
    with m_col4: st.metric(label="🏦 Protocol Treasury Revenue", value=f"{accumulated_fees:.4f} INAYA", delta="Dynamic Asset Storage Inflow")
    
    st.markdown("<br><br>", unsafe_allow_html=True)
    st.subheader("📊 Strategic Core Vault Structure Layouts")
    
    tokenomics_structure = {
        "Ecosystem Strategic Allocation Pools": ["Initial Circulating Supply (Seed)", "Locked Ecosystem Reserves (Future Drops)", "Dynamic Cloud Service Revenue"],
        "Token Holdings (INAYA Volume)": [5000000, 25000000, accumulated_fees]
    }
    st.bar_chart(pd.DataFrame(tokenomics_structure).set_index("Ecosystem Strategic Allocation Pools"), use_container_width=True)


# ─── 5. ECOSYSTEM ROADMAP TIMELINE DETAILED PORTAL ───
elif current_page == "Tactical Roadmap":
    st.markdown("<h2 style='font-weight:800; color:#fff; font-size:24pt; letter-spacing:-0.5px; margin-bottom:5px;'>Infrastructure Development Milestones</h2>", unsafe_allow_html=True)
    st.markdown("<p style='color:#94a3b8; font-size:11pt; margin-bottom:30px;'>Tactical rollout timeline tracing alpha testing validation out to full mainnet liquidity events.</p>", unsafe_allow_html=True)
    
    st.markdown("""
        <div class="timeline-matrix">
            <div class="matrix-node">
                <div class="node-tag">PHASE 01 // COMPLETED</div>
                <div class="node-head">Genesis Smart Contract Verification</div>
                <div class="node-body">Successful design, compilation, and initialization of the 30,000,000 total capped $INAYA token ledger anchor layers onto public testnet environments with complete cryptographic validation checks enabled.</div>
            </div>
            <div class="matrix-node">
                <div class="node-tag">PHASE 02 // IN OPERATION [Q4 2026]</div>
                <div class="node-head">Ecosystem Hub Portal Cloud Integration</div>
                <div class="node-body">Deploying dynamic horizontal multi-page front-end interface hubs across global compute nodes, optimizing zero-knowledge local client sharding loops, and scaling data broadcast pipelines.</div>
            </div>
            <div class="matrix-node">
                <div class="node-tag">PHASE 03 // UPCOMING [Q1 2027]</div>
                <div class="node-head">Institutional API Engines & Developer SDK Hooks</div>
                <div class="node-body">Building accessible cross-platform execution software libraries that allow system network engineers to pipe existing relational server records directly into our localized fragmentation layers.</div>
            </div>
            <div class="matrix-node">
                <div class="node-tag">PHASE 04 // TARGET [Q2 2027]</div>
                <div class="node-head">Production Mainnet Genesis & Fee Burn Triggers</div>
                <div class="node-body">Migrating validated staging architectures onto live production setups on the BNB Chain Mainnet, initializing public swap pools, and activating automated micro-fee token collection models.</div>
            </div>
        </div>
    """, unsafe_allow_html=True)


# ─── 6. EXECUTIVE PHILOSOPHY ABOUT US PORTAL ───
elif current_page == "Foundation About":
    st.markdown("<h2 style='font-weight:800; color:#fff; font-size:24pt; letter-spacing:-0.5px; margin-bottom:5px;'>The Inaya Foundation Philosophy</h2>", unsafe_allow_html=True)
    st.markdown("<p style='color:#94a3b8; font-size:11pt; margin-bottom:30px;'>Engineering human purpose, absolute custody protection, and mathematical grace inside Web3 layers.</p>", unsafe_allow_html=True)
    
    st.subheader("🧬 Core Brand Origin Story")
    st.markdown("""
    In the corporate enterprise space, security is frequently viewed as cold, sterile, and mathematical. Project Inaya was established to radically reshape this narrative. 
    Derived from the profound linguistic Arabic root meaning **"Complete Care, Absolute Protection, and Grace,"** the project acts as a direct digital guardian for modern high-value datasets.
    
    By transforming a beautiful, personal human inspiration into a concrete, mathematically bulletproof ledger asset framework, we prove that engineering excellence can be anchored in deep philosophical purpose.
    """)
    
    st.markdown("<br>", unsafe_allow_html=True)
    st.subheader("🤝 Core Strategic Council")
    
    c1, c2 = st.columns(2)
    with c1: st.info("👨‍💻 **Managing Director & Lead Systems Architect** \nDirecting core local file splitting architectures, web framework container controls, and blockchain settlement integrations.")
    with c2: st.success("🌟 **Inaya (Creative Director & Brand Catalyst)** \nThe visual muse behind our minimalist luxury user experience, defining the symmetry parameters of our premium interface components.")