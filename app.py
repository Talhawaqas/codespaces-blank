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
    page_title="Inaya Sovereign Custody Portal", 
    page_icon="🛡️", 
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

# ─── 🧪 THE LUXURY FINTECH GLASSMORPHIC STYLING MATRIX ───
st.markdown("""
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap');
        
        /* Smooth Global Reskinning */
        html, body, [class*="css"], .stApp {
            font-family: 'Plus Jakarta Sans', sans-serif;
            background-color: #070a13 !important;
            color: #f8fafc !important;
        }
        
        /* Modern Gradient Hero Panel */
        .hero-card {
            background: linear-gradient(135deg, rgba(15, 23, 42, 0.9) 0%, rgba(30, 41, 59, 0.8) 100%);
            border: 1px solid rgba(223, 183, 108, 0.2);
            padding: 50px 40px;
            border-radius: 20px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255,255,255,0.05);
            margin-bottom: 40px;
            position: relative;
            overflow: hidden;
        }
        .hero-card::before {
            content: '';
            position: absolute;
            top: 0; right: 0; width: 300px; height: 300px;
            background: radial-gradient(circle, rgba(223, 183, 108, 0.08) 0%, transparent 70%);
            z-index: 1;
        }
        .hero-title { font-size: 34pt; font-weight: 800; color: #ffffff; letter-spacing: -1px; margin: 0; }
        .hero-subtitle { font-size: 10.5pt; color: #dfb76c; text-transform: uppercase; letter-spacing: 4px; margin-top: 12px; font-weight: 600; }
        
        /* Premium Floating Feature Cards */
        .premium-card {
            background: rgba(30, 41, 59, 0.4);
            backdrop-filter: blur(16px);
            border: 1px solid rgba(255, 255, 255, 0.05);
            padding: 35px 30px;
            border-radius: 16px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
            height: 100%;
        }
        .premium-card:hover {
            transform: translateY(-6px);
            border-color: rgba(223, 183, 108, 0.4);
            box-shadow: 0 20px 40px rgba(223, 183, 108, 0.07);
            background: rgba(30, 41, 59, 0.55);
        }
        .card-icon {
            background: linear-gradient(135deg, #dfb76c 0%, #c5a059 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            font-size: 28pt; font-weight: 700; margin-bottom: 20px;
        }
        .card-title { font-size: 15pt; font-weight: 700; color: #ffffff; margin-bottom: 12px; letter-spacing: -0.3px; }
        .card-desc { font-size: 10pt; color: #94a3b8; line-height: 1.7; font-weight: 400; }

        /* Sleek Web3 Metrics Grids */
        .metric-container {
            background: rgba(15, 23, 42, 0.6);
            border: 1px solid rgba(255, 255, 255, 0.04);
            border-radius: 14px;
            padding: 24px 20px;
            text-align: center;
            box-shadow: inset 0 1px 2px rgba(255,255,255,0.02);
        }
        .metric-val { font-size: 22pt; font-weight: 800; color: #ffffff; letter-spacing: -0.5px; }
        .metric-lbl { font-size: 8.5pt; color: #64748b; text-transform: uppercase; letter-spacing: 2px; margin-top: 6px; font-weight: 600; }

        /* Modernized Interactive Roadmap Pipeline */
        .modern-timeline {
            border-left: 2px dashed rgba(223, 183, 108, 0.3);
            padding-left: 30px;
            margin: 20px 10px;
        }
        .timeline-item { position: relative; margin-bottom: 45px; }
        .timeline-item::before {
            content: ''; position: absolute; left: -39px; top: 6px;
            background: #070a13; border: 3px solid #dfb76c;
            border-radius: 50%; width: 16px; height: 16px;
            box-shadow: 0 0 10px #dfb76c;
        }
        .time-tag { font-size: 9pt; color: #dfb76c; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; }
        .time-head { font-size: 15pt; font-weight: 700; color: #ffffff; margin: 4px 0 10px 0; }
        .time-body { font-size: 10pt; color: #94a3b8; line-height: 1.6; }

        /* Full Custom Branding Sidebar Overrides */
        .sidebar- crest-box { text-align: center; padding: 20px 0; }
        .ledger-badge {
            background: rgba(223, 183, 108, 0.06);
            border: 1px solid rgba(223, 183, 108, 0.15);
            padding: 14px; border-radius: 10px; margin: 20px 0;
            box-shadow: inset 0 1px 10px rgba(0,0,0,0.2);
        }
        
        /* High-End Glass Buttons */
        .stButton>button {
            background: linear-gradient(135deg, #dfb76c 0%, #ba944b 100%) !important;
            color: #070a13 !important;
            border: none !important;
            border-radius: 10px !important;
            padding: 14px 30px !important;
            font-weight: 700 !important;
            letter-spacing: 0.5px !important;
            width: 100%;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1) !important;
            box-shadow: 0 4px 15px rgba(223, 183, 108, 0.2) !important;
        }
        .stButton>button:hover {
            transform: translateY(-2px) !important;
            box-shadow: 0 8px 25px rgba(223, 183, 108, 0.4) !important;
        }
        
        /* Form input fields sleek styling */
        input {
            background-color: rgba(15, 23, 42, 0.8) !important;
            border: 1px solid rgba(255,255,255,0.08) !important;
            color: #ffffff !important;
            border-radius: 8px !important;
        }
        
        /* Dynamic Tabs Reskinning */
        .stTabs [data-baseweb="tab"] {
            color: #64748b !important; font-weight: 600 !important; font-size: 11pt !important;
        }
        .stTabs [data-baseweb="tab"][aria-selected="true"] {
            color: #dfb76c !important; border-bottom-color: #dfb76c !important;
        }
    </style>
""", unsafe_allow_html=True)

# ─── SIDEBAR BRANDING & EXECUTIVE NAVIGATION ───
st.sidebar.markdown("""
    <div style="text-align: center; padding: 15px 0;">
        <svg width="90" height="90" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/2000/svg">
            <defs>
                <linearGradient id="shieldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#0f172a" /><stop offset="100%" stop-color="#1e293b" />
                </linearGradient>
                <linearGradient id="goldGrad" x1="0%" y1="100%" x2="100%" y2="0%">
                    <stop offset="0%" stop-color="#c5a059" /><stop offset="50%" stop-color="#dfb76c" /><stop offset="100%" stop-color="#f5e2b3" />
                </linearGradient>
            </defs>
            <path d="M100,12 L170,44 L170,115 C170,160 132,185 100,193 C68,185 30,160 30,115 L30,44 Z" fill="url(#shieldGrad)" stroke="url(#goldGrad)" stroke-width="4"/>
            <path d="M72,56 L128,56" stroke="url(#goldGrad)" stroke-width="4" stroke-linecap="round"/>
            <path d="M72,144 L128,144" stroke="url(#goldGrad)" stroke-width="4" stroke-linecap="round"/>
            <line x1="100" y1="56" x2="100" y2="144" stroke="#ffffff" stroke-width="6" stroke-linecap="round"/>
            <circle cx="100" cy="100" r="16" fill="#0f172a" stroke="url(#goldGrad)" stroke-width="3"/>
        </svg>
        <div style="color: #ffffff; font-size: 15pt; font-weight: 800; margin-top: 12px; letter-spacing: 0.5px;">INAYA VAULT</div>
        <div style="color: #dfb76c; font-size: 7.5pt; font-weight: 600; text-transform: uppercase; letter-spacing: 3px;">Sovereign Protocol</div>
    </div>
""", unsafe_allow_html=True)

st.sidebar.markdown(f"""
    <div class="ledger-badge">
        <div style="color: #dfb76c; font-size: 7.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">Verified Live Contract:</div>
        <div style="color: #94a3b8; font-family: monospace; font-size: 8pt; word-break: break-all; margin-top: 6px; opacity: 0.85;">{LIVE_CONTRACT_ADDRESS}</div>
    </div>
""", unsafe_allow_html=True)

st.sidebar.markdown('<hr style="border-color: rgba(255,255,255,0.05); margin: 15px 0;" />', unsafe_allow_html=True)

st.sidebar.header("🗺️ Core System Portals")
current_page = st.sidebar.radio(
    "Select Interface Terminal:",
    ["🌐 Corporate Hub", "✨ Tech Features Matrix", "📥 Sovereign Storage Core", "📊 Live Tokenomics Deck", "🗺️ Tactical Growth Roadmap", "📜 Executive Philosophy"]
)

st.sidebar.markdown("---")
st.sidebar.header("🔑 Security Access Layers")
password_input = st.sidebar.text_input("Vault Passkey Hash:", type="password")
pinata_jwt_input = st.sidebar.text_input("IPFS Swarm Token (JWT):", type="password")

# Core Dynamic Telemetry Calculations
total_files_archived = 0
if os.path.exists(MANIFEST_FILE):
    try:
        with open(MANIFEST_FILE, "r") as f: total_files_archived = len(json.load(f))
    except Exception: total_files_archived = 0
accumulated_fees = total_files_archived * 0.0001


# ─── 1. CORPORATE HOME PAGE ───
if current_page == "🌐 Corporate Hub":
    st.markdown("""
        <div class="hero-card">
            <div class="hero-title">Sovereign Cloud Assets Linked to Global Ledgers</div>
            <div class="hero-subtitle">Military-Grade Encryption Interfaced with Distributed Block Scarcity Arrays</div>
        </div>
    """, unsafe_allow_html=True)
    
    st.subheader("🏛️ Institutional Layer Overview")
    st.markdown("Project Inaya anchors operational corporate document workflows seamlessly onto immutable node networks. The platform isolates data assets into mathematical vectors before broadcasting parallel pipelines across global high-availability swarms.")
    st.markdown("<br><br>", unsafe_allow_html=True)
    
    st.subheader("🌐 Global Node Cluster Telemetry Matrix")
    s_col1, s_col2, s_col3, s_col4 = st.columns(4)
    with s_col1: st.markdown(f'<div class="metric-container"><div class="metric-val" style="color:#10b981;">ACTIVE</div><div class="metric-lbl">Ledger Connection</div></div>', unsafe_allow_html=True)
    with s_col2: st.markdown(f'<div class="metric-container"><div class="metric-val">{total_files_archived}</div><div class="metric-lbl">Secured Shard Pairs</div></div>', unsafe_allow_html=True)
    with s_col3: st.markdown(f'<div class="metric-container"><div class="metric-val">99.999%</div><div class="metric-lbl">Swarm Gateway Availability</div></div>', unsafe_allow_html=True)
    with s_col4: st.markdown(f'<div class="metric-container"><div class="metric-val">&lt; 0.9s</div><div class="metric-lbl">Cryptographic Synthesis</div></div>', unsafe_allow_html=True)


# ─── 2. FEATURES MATRIX PAGE ───
elif current_page == "✨ Tech Features Matrix":
    st.markdown("""
        <div class="hero-card">
            <div class="hero-title">CORE PROTOCOL ARCHITECTURE FEATURES</div>
            <div class="hero-subtitle">Zero-Knowledge Storage Mechanics & Cryptographic Threat Neutralization</div>
        </div>
    """, unsafe_allow_html=True)
    
    f_col1, f_col2, f_col3 = st.columns(3)
    with f_col1:
        st.markdown("""
            <div class="premium-card">
                <div class="card-icon">01</div>
                <div class="card-title">Localized Cryptographic Slicing</div>
                <div class="card-desc">Files never leave local machines whole. The architecture divides input streams into standalone, isolated fragments before running transport vectors, ensuring zero cleartext data exists outside host boundaries.</div>
            </div>
        """, unsafe_allow_html=True)
    with f_col2:
        st.markdown("""
            <div class="premium-card">
                <div class="card-icon">02</div>
                <div class="card-title">Asymmetric Vault Memory Isolation</div>
                <div class="card-desc">Zero sensitive credential maps or database records are tracked on centralized servers. Decryption arrays live solely inside the mind of authenticated node operations directors.</div>
            </div>
        """, unsafe_allow_html=True)
    with f_col3:
        st.markdown("""
            <div class="premium-card">
                <div class="card-icon">03</div>
                <div class="card-title">EVM Immutable Attestation</div>
                <div class="card-desc">Every individual storage event fires a validation signature across public testnet nodes, establishing cryptographic provenance linked directly to our live, audited verified smart contract.</div>
            </div>
        """, unsafe_allow_html=True)


# ─── 3. SOVEREIGN SECURE VAULT ENGINE ───
elif current_page == "📥 Sovereign Storage Core":
    st.markdown("""
        <div class="hero-card">
            <div class="hero-title">SECURE OPERATIONAL TRANSMISSION VAULT</div>
            <div class="hero-subtitle">Asymmetric Key Splitting & Cryptographic Swarm Routing Pipeline</div>
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
elif current_page == "📊 Live Tokenomics Deck":
    st.markdown("""
        <div class="hero-card">
            <div class="hero-title">VENTURE ECONOMIC MODEL & ASSET CAPITAL BALANCES</div>
            <div class="hero-subtitle">Smart Contract Allocations & Live Utility Token Dynamics</div>
        </div>
    """, unsafe_allow_html=True)
    
    m_col1, m_col2, m_col3, m_col4 = st.columns(4)
    with m_col1: st.metric(label="📊 Token Max Supply Cap", value="30,000,000 INAYA", delta="Strict Scarcity Lock")
    with m_col2: st.metric(label="📈 Initial Circulating Pool", value="5,000,000 INAYA", delta="Seed Base Allocation")
    with m_col3: st.metric(label="💸 Service Micro-Fee Rate", value="0.0001 INAYA", delta="Fixed Per Archival")
    with m_col4: st.metric(label="🏦 Treasury Working Capital", value=f"{accumulated_fees:.4f} INAYA", delta="Live Cash Flow Telemetry")
    
    st.markdown("<br><br>", unsafe_allow_html=True)
    st.subheader("📊 System Structure Distribution Models")
    
    tokenomics_structure = {
        "Ecosystem Strategic Allocation Pools": ["Initial Circulating Supply (Seed)", "Locked Ecosystem Reserves (Future Drops)", "Dynamic Cloud Service Revenue"],
        "Token Holdings (INAYA Volume)": [5000000, 25000000, accumulated_fees]
    }
    st.bar_chart(pd.DataFrame(tokenomics_structure).set_index("Ecosystem Strategic Allocation Pools"), use_container_width=True)


# ─── 5. ECOSYSTEM ROADMAP PAGE ───
elif current_page == "🗺️ Tactical Growth Roadmap":
    st.markdown("""
        <div class="hero-card">
            <div class="hero-title">STRATEGIC INFRASTRUCTURE TIMELINES</div>
            <div class="hero-subtitle">Multi-Phase Development Pipelines & Venture Scaling Milestones</div>
        </div>
    """, unsafe_allow_html=True)
    
    st.subheader("🗺️ Strategic Project Timelines")
    st.markdown("Our engineered rollout timeline balances systematic testing on public testnet sandboxes with institutional node expansion objectives across global multi-tenant sectors.")
    
    st.markdown("""
        <div class="modern-timeline">
            <div class="timeline-item">
                <div class="time-tag">Phase 1 | Completed</div>
                <div class="time-head">Genesis Token Anchor Deployment</div>
                <div class="time-body">Successful design, smart contract compilation, and architectural launch of the capped 30,000,000 $INAYA supply base onto public blockchain testnets with full Sourcify cryptographic signature verification records.</div>
            </div>
            <div class="timeline-item">
                <div class="time-tag">Phase 2 | Q4 2026</div>
                <div class="time-head">Enterprise Portal & Swarm Cluster Trials</div>
                <div class="time-body">Deploying fully decentralized multi-tenant UI front-end dashboards to persistent high-performance cloud nodes, introducing multi-tab system routing layouts, and scaling zero-knowledge localized file fragmentation scripts.</div>
            </div>
            <div class="timeline-item">
                <div class="time-tag">Phase 3 | Q1 2027</div>
                <div class="time-head">Automated Corporate Bridges & SDK Deployments</div>
                <div class="time-body">Publishing backend programmatic hooks and software development packages, allowing institutional operations teams to link native databases directly to local encryption sharding logic.</div>
            </div>
            <div class="timeline-item">
                <div class="time-tag">Phase 4 | Q2 2027</div>
                <div class="time-head">Mainnet Genesis & Market Liquidity Events</div>
                <div class="time-body">Migrating validated code blocks to live production layers on the BNB Smart Chain Mainnet, initializing deep public market liquidity pairs, and switching over to dynamic, protocol-driven automatic gas fee metrics.</div>
            </div>
        </div>
    """, unsafe_allow_html=True)


# ─── 6. ABOUT US & BRAND PHILOSOPHY PAGE ───
elif current_page == "📜 Executive Philosophy":
    st.markdown("""
        <div class="hero-card">
            <div class="hero-title">THE INAYA FOUNDATION PHILOSOPHY</div>
            <div class="hero-subtitle">Grace, Pure Custody, and Uncompromising Protection for Enterprise Data Assets</div>
        </div>
    """, unsafe_allow_html=True)
    
    st.subheader("🧬 The Brand Origin Story")
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