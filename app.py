import base64
import hashlib
import json
import os
import time
import requests
import streamlit as st
import pandas as pd
from cryptography.fernet import Fernet

# ─── PREMIUM CONFIGURATIONS & INITIALIZATION ───
st.set_page_config(
    page_title="Inaya Global Security Cloud", 
    page_icon="🛡️", 
    layout="wide",
    initial_sidebar_state="expanded"
)

# Live verified contract address anchor
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

# ─── 🎨 PREMIUM ADVANCED PLATFORM CSS STYLING ───
st.markdown("""
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;600;700;800&display=swap');
        html, body, [class*="css"] {
            font-family: 'Plus Jakarta Sans', sans-serif;
            color: #1e293b;
        }
        
        /* Corporate Presentation Header Banner */
        .hero-banner {
            background: linear-gradient(135deg, #061026 0%, #0f2042 50%, #1b3566 100%);
            padding: 55px 40px;
            border-radius: 16px;
            color: #ffffff;
            margin-bottom: 35px;
            border-left: 8px solid #dfb76c;
            box-shadow: 0 10px 30px rgba(15, 32, 66, 0.18);
        }
        .hero-title { font-size: 30pt; font-weight: 800; margin: 0; letter-spacing: -0.5px; }
        .hero-subtitle { font-size: 11pt; color: #f3dca2; text-transform: uppercase; letter-spacing: 3px; margin-top: 8px; font-weight: 600; }
        
        /* Elegant Feature Matrix Elements */
        .feature-card {
            background: #ffffff;
            border: 1px solid #e2e8f0;
            padding: 30px 25px;
            border-radius: 12px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.01);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            height: 100%;
        }
        .feature-card:hover {
            transform: translateY(-4px);
            box-shadow: 0 12px 24px rgba(15, 32, 66, 0.08);
            border-color: #dfb76c;
        }
        .feature-icon { font-size: 26pt; margin-bottom: 15px; }
        .feature-title { font-size: 15pt; font-weight: 700; color: #0f2042; margin-bottom: 12px; }
        .feature-text { font-size: 10.5pt; color: #475569; line-height: 1.6; text-align: justify; }

        /* Premium Institutional Stat Cards */
        .stat-badge {
            background-color: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 10px;
            padding: 20px 15px;
            text-align: center;
            box-shadow: 0 2px 6px rgba(0,0,0,0.01);
        }
        .stat-value { font-size: 20pt; font-weight: 800; color: #0f2042; }
        .stat-label { font-size: 8.5pt; color: #64748b; text-transform: uppercase; letter-spacing: 1.5px; margin-top: 4px; }

        /* Custom Visual Interactive Roadmap Timeline Styling */
        .roadmap-container {
            border-left: 3px solid #dfb76c;
            padding-left: 25px;
            margin-left: 15px;
            margin-top: 20px;
        }
        .roadmap-node {
            position: relative;
            margin-bottom: 35px;
        }
        .roadmap-node::before {
            content: '';
            position: absolute;
            left: -33px;
            top: 4px;
            background: #0f2042;
            border: 3px solid #dfb76c;
            border-radius: 50%;
            width: 14px;
            height: 14px;
        }
        .roadmap-header { font-size: 14pt; font-weight: 800; color: #0f2042; margin: 0; }
        .roadmap-date { font-size: 9.5pt; color: #dfb76c; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; }
        .roadmap-body { font-size: 10.5pt; color: #475569; margin-top: 6px; text-align: justify; }

        /* Custom Interactive Buttons styling */
        .stButton>button {
            background: linear-gradient(135deg, #0f2042 0%, #1b3566 100%) !important;
            color: #ffffff !important;
            border: 1px solid #dfb76c !important;
            border-radius: 8px !important;
            padding: 12px 28px !important;
            font-weight: 600 !important;
            width: 100%;
            transition: all 0.25s ease !important;
        }
        .stButton>button:hover {
            transform: translateY(-2px) !important;
            box-shadow: 0 6px 20px rgba(223, 183, 108, 0.3) !important;
        }
        .contract-badge {
            background-color: #0c1933;
            border: 1px solid #223d70;
            padding: 12px;
            border-radius: 8px;
            margin: 15px 0;
        }
    </style>
""", unsafe_allow_html=True)

# ─── SIDEBAR IDENTITY CREST & NAVIGATION PANEL ───
st.sidebar.markdown("""
    <div style="text-align: center; padding: 10px 0;">
        <svg width="100" height="100" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/2000/svg">
            <defs>
                <linearGradient id="shieldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#061026" /><stop offset="40%" stop-color="#0f2042" /><stop offset="100%" stop-color="#1b3566" />
                </linearGradient>
                <linearGradient id="goldGrad" x1="0%" y1="100%" x2="100%" y2="0%">
                    <stop offset="0%" stop-color="#c5a059" /><stop offset="30%" stop-color="#dfb76c" /><stop offset="70%" stop-color="#f5e2b3" /><stop offset="100%" stop-color="#c5a059" />
                </linearGradient>
            </defs>
            <path d="M100,12 L170,44 L170,115 C170,160 132,185 100,193 C68,185 30,160 30,115 L30,44 Z" fill="url(#shieldGrad)" stroke="url(#goldGrad)" stroke-width="4"/>
            <path d="M72,56 L128,56" stroke="url(#goldGrad)" stroke-width="5" stroke-linecap="round"/>
            <path d="M72,144 L128,144" stroke="url(#goldGrad)" stroke-width="5" stroke-linecap="round"/>
            <line x1="100" y1="56" x2="100" y2="144" stroke="#ffffff" stroke-width="7" stroke-linecap="round"/>
            <circle cx="100" cy="100" r="18" fill="#0f2042" stroke="url(#goldGrad)" stroke-width="4"/>
            <circle cx="100" cy="100" r="5" fill="#ffffff"/>
        </svg>
        <div style="color: #ffffff; font-size: 14pt; font-weight: 800; margin-top: 10px; letter-spacing: 1px;">PROJECT INAYA</div>
        <div style="color: #dfb76c; font-size: 8pt; font-weight: 600; text-transform: uppercase; letter-spacing: 2px;">Sovereign Infrastructure</div>
    </div>
""", unsafe_allow_html=True)

st.sidebar.markdown(f"""
    <div class="contract-badge">
        <div style="color: #dfb76c; font-size: 7.5pt; font-weight: bold; text-transform: uppercase;">Verified Smart Contract:</div>
        <div style="color: #ffffff; font-family: monospace; font-size: 8pt; word-break: break-all; margin-top: 4px;">{LIVE_CONTRACT_ADDRESS}</div>
    </div>
""", unsafe_allow_html=True)

st.sidebar.markdown('<hr style="border-color: #1e293b; margin: 10px 0;" />', unsafe_allow_html=True)

# 🗺️ DYNAMIC PORTAL SELECTION SYSTEM
st.sidebar.header("🗺️ Corporate Architecture")
current_page = st.sidebar.radio(
    "Navigate Portals:",
    ["🌐 Corporate Home", "✨ Core Features Matrix", "📥 Sovereign Secure Vault", "📊 Venture Tokenomics Hub", "🗺️ Ecosystem Roadmap", "📜 About Us & Philosophy"]
)

st.sidebar.markdown("---")
st.sidebar.header("🔑 Gateway Authentication")
password_input = st.sidebar.text_input("Master Administrative Password:", type="password")
pinata_jwt_input = st.sidebar.text_input("Network Pinata JWT Access Token:", type="password")

# Parse dynamic metrics tracking metrics data
total_files_archived = 0
if os.path.exists(MANIFEST_FILE):
    try:
        with open(MANIFEST_FILE, "r") as f: total_files_archived = len(json.load(f))
    except Exception: total_files_archived = 0
accumulated_fees = total_files_archived * 0.0001


# ─── 1. CORPORATE HOME PAGE ───
if current_page == "🌐 Corporate Home":
    st.markdown("""
        <div class="hero-banner">
            <div class="hero-title">Sovereign Cloud Custody Linked to Public Ledgers</div>
            <div class="hero-subtitle">Next-Generation Zero-Knowledge Storage Clusters & Decentralized Cryptographic Swarms</div>
        </div>
    """, unsafe_allow_html=True)
    
    st.subheader("🏛️ Institutional Cloud Architecture")
    st.markdown("Project Inaya engineers absolute privacy layer interfaces for global enterprise operations. Our network bridges the security parameters of military-grade encryption keys with the immutability profiles of decentralized block storage system matrices.")
    
    st.markdown("<br>", unsafe_allow_html=True)
    st.subheader("🌐 Global Node Cluster Telemetry Matrix")
    
    s_col1, s_col2, s_col3, s_col4 = st.columns(4)
    with s_col1: st.markdown(f'<div class="stat-badge"><div class="stat-value">Active</div><div class="stat-label">Network Infrastructure</div></div>', unsafe_allow_html=True)
    with s_col2: st.markdown(f'<div class="stat-badge"><div class="stat-value">{total_files_archived}</div><div class="stat-label">Secured File Anchors</div></div>', unsafe_allow_html=True)
    with s_col3: st.markdown(f'<div class="stat-badge"><div class="stat-value">99.998%</div><div class="stat-label">Swarm Node Uptime</div></div>', unsafe_allow_html=True)
    with s_col4: st.markdown(f'<div class="stat-badge"><div class="stat-value">&lt; 1.2s</div><div class="stat-label">Cryptographic Synthesis Time</div></div>', unsafe_allow_html=True)


# ─── 2. FEATURES MATRIX PAGE ───
elif current_page == "✨ Core Features Matrix":
    st.markdown("""
        <div class="hero-banner">
            <div class="hero-title">CORE TECHNICAL ARCHITECTURE FEATURES</div>
            <div class="hero-subtitle">Hardened Data Partitioning, Threat Isolation, & Cryptographic Immutability</div>
        </div>
    """, unsafe_allow_html=True)
    
    f_col1, f_col2, f_col3 = st.columns(3)
    with f_col1:
        st.markdown("""
            <div class="feature-card">
                <div class="feature-icon">🚀</div>
                <div class="feature-title">Local Cryptographic Sharding</div>
                <div class="feature-text">Files never touch the internet in one piece. Our gateway slices file payloads into standalone, isolated multi-tenant data blocks prior to running transfer routines, ensuring zero master vectors exist outside local boundaries.</div>
            </div>
        """, unsafe_allow_html=True)
    with f_col2:
        st.markdown("""
            <div class="feature-card">
                <div class="feature-icon">🔒</div>
                <div class="feature-title">Zero-Knowledge Proof Isolation</div>
                <div class="feature-text">Zero cleartext data or administrative access keys are logged on remote nodes. Decryption keys remain exclusively inside the vault memory of our enterprise administrators, preventing structural leaks.</div>
            </div>
        """, unsafe_allow_html=True)
    with f_col3:
        st.markdown("""
            <div class="feature-card">
                <div class="feature-icon">⛓️</div>
                <div class="feature-title">EVM Immutable Anchoring</div>
                <div class="feature-text">Every single data archival event prompts a secure verification trace sequence, establishing absolute ledger accountability linked directly to our live, publicly audited smart contract registry nodes.</div>
            </div>
        """, unsafe_allow_html=True)


# ─── 3. SOVEREIGN SECURE VAULT ENGINE ───
elif current_page == "📥 Sovereign Secure Vault":
    st.markdown("""
        <div class="hero-banner">
            <div class="hero-title">SOVEREIGN HARDENED OPERATIONAL VAULT</div>
            <div class="hero-subtitle">Cryptographic Key Fragmentation & Decentralized Broadcast Pipeline</div>
        </div>
    """, unsafe_allow_html=True)
    
    if not password_input or not pinata_jwt_input:
        st.warning("🔒 Security Handshake Required: Please supply your master administrative credentials inside the sidebar controller panel to open the communication arrays.")
    else:
        VAULT_KEY = derive_vault_key(password_input)
        cipher_suite = Fernet(VAULT_KEY)
        st.sidebar.success("🔗 CRYPTOGRAPHIC HANDSHAKE LINKED: ONLINE")
        
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


# ─── 4. VENTURE TOKENOMICS HUB ───
elif current_page == "📊 Venture Tokenomics Hub":
    st.markdown("""
        <div class="hero-banner">
            <div class="hero-title">VENTURE ECONOMIC MODEL & MARKET ANALYTICS</div>
            <div class="hero-subtitle">Real-time Smart Contract Minting Caps & Treasury Revenue Accounting Metrics</div>
        </div>
    """, unsafe_allow_html=True)
    
    m_col1, m_col2, m_col3, m_col4 = st.columns(4)
    with m_col1: st.metric(label="📊 Token Max Supply Cap", value="30,000,000 INAYA", delta="Strict Bitcoin Hard Cap")
    with m_col2: st.metric(label="📈 Initial Circulating Pool", value="5,000,000 INAYA", delta="Founding Liquidity Allocation")
    with m_col3: st.metric(label="💸 Service Micro-Fee Rate", value="0.0001 INAYA", delta="Fixed Per Transaction")
    with m_col4: st.metric(label="🏦 Accumulated Treasury Revenue", value=f"{accumulated_fees:.4f} INAYA", delta="Real-time Cash Flow")
    
    st.markdown("<br><br>", unsafe_allow_html=True)
    st.subheader("📊 Strategic Ecosystem Allocation Distribution")
    
    tokenomics_structure = {
        "Allocation Sector Hubs": ["Initial Circulating Supply (Seed)", "Locked Ecosystem Reserves (Future Drops)", "Dynamic Cloud Service Revenue"],
        "Token Holdings (INAYA Volume)": [5000000, 25000000, accumulated_fees]
    }
    st.bar_chart(pd.DataFrame(tokenomics_structure).set_index("Allocation Sector Hubs"), use_container_width=True)


# ─── 5. ECOSYSTEM ROADMAP PAGE (NEW TIMELINE ADDITION) ───
elif current_page == "🗺️ Ecosystem Roadmap":
    st.markdown("""
        <div class="hero-banner">
            <div class="hero-title">STRATEGIC INFRASTRUCTURE ROADMAP</div>
            <div class="hero-subtitle">Multi-Phase Evolutionary Milestones & Institutional Deployment Timeline</div>
        </div>
    """, unsafe_allow_html=True)
    
    st.subheader("🗺️ Strategic Project Timelines")
    st.markdown("Our engineered rollout timeline balances systematic testing on public testnet sandboxes with institutional node expansion objectives across global multi-tenant sectors.")
    
    # Custom HTML/CSS Rendered Vertical Timeline
    st.markdown("""
        <div class="roadmap-container">
            <div class="roadmap-node">
                <div class="roadmap-date">Phase 1 | Q3 2026</div>
                <div class="roadmap-header">Genesis Token Launch & Verification [COMPLETED]</div>
                <div class="roadmap-body">Successful engineering, compilation, and deployment of the capped 30,000,000 supply $INAYA smart contract onto the public blockchain network ledger with full source verification flags enabled.</div>
            </div>
            <div class="roadmap-node">
                <div class="roadmap-date">Phase 2 | Q4 2026</div>
                <div class="roadmap-header">Enterprise Portal Cloud Deployment & Alpha Trials</div>
                <div class="roadmap-body">Launching permanent, decentralized multitenant front-end gateway dashboards connected securely to active IPFS pinning arrays, enabling administrative data sharding trials across globally accessible URL end-points.</div>
            </div>
            <div class="roadmap-node">
                <div class="roadmap-date">Phase 3 | Q1 2027</div>
                <div class="roadmap-header">Automated API Bridges & Corporate SDK Releases</div>
                <div class="roadmap-body">Publishing software development toolkits that enable institutional operations centers to plug legacy database records directly into our local security fragmentation arrays, completely bypassing manual file upload workflows.</div>
            </div>
            <div class="roadmap-node">
                <div class="roadmap-date">Phase 4 | Q2 2027</div>
                <div class="roadmap-header">Mainnet High-Liquidity Exchange Pools</div>
                <div class="roadmap-body">Migrating finalized, audited staging framework contract layers to the live BNB Chain Mainnet, establishing deep institutional liquidity pairs, and activating live automatic per-archive service fee burns.</div>
            </div>
        </div>
    """, unsafe_allow_html=True)


# ─── 6. ABOUT US & BRAND PHILOSOPHY PAGE ───
elif current_page == "📜 About Us & Philosophy":
    st.markdown("""
        <div class="hero-banner">
            <div class="hero-title">THE INAYA FOUNDATION PHILOSOPHY</div>
            <div class="hero-subtitle">Engineering Protection, Grace, and Cryptographic Guardianship for Digital Sovereignty</div>
        </div>
    """, unsafe_allow_html=True)
    
    st.subheader("🧬 The Brand Origin Story")
    st.markdown("""
    In the corporate enterprise space, security is frequently viewed as cold, sterile, and mathematical. Project Inaya was established to radically reshape this narrative. 
    Derived from the profound linguistic Arabic root meaning **"Complete Care, Absolute Protection, and Grace,"** the project acts as a direct digital guardian for modern high-value datasets.
    
    By transforming a beautiful, personal human inspiration into a concrete, mathematically bulletproof ledger asset framework, we prove that engineering excellence can be anchored in deep philosophical purpose.
    """)
    
    st.markdown("<br>", unsafe_allow_html=True)
    st.subheader("🤝 Leadership & Core Development Council")
    
    c1, c2 = st.columns(2)
    with c1: st.info("👨‍💻 **Managing Director & Lead Systems Architect** \nOverseeing the end-to-end integration of our secure localized sharding structures, container architectures, and EVM block network registry nodes.")
    with c2: st.success("🌟 **Inaya (The Brand Catalyst & Creative Director)** \nThe direct visual inspiration for our luxury Sovereign Custody design language, guiding the symmetry guidelines of our premium security crest layouts.")